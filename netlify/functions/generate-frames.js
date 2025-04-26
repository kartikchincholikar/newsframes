const AWS = require('aws-sdk');
AWS.config.update({
  accessKeyId: process.env.ACCESS_KEY_ID,
  secretAccessKey: process.env.SECRET_ACCESS_KEY,
  region: process.env.REGION,
});

const docClient = new AWS.DynamoDB.DocumentClient();
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

// Generic model call using Model Context Protocol
async function callModel(messages, model = 'gemini-1.5-flash-latest') {
  const API_KEY = process.env.GEMINI_API_KEY;
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const body = {
    instances: [{ messages }],
    parameters: {
      temperature: 0.5,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
    },
  };

  const res = await fetch(`${API_URL}?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error('Model API error:', text);
    throw new Error(`Model error ${res.status}`);
  }

  const responseJson = JSON.parse(text);
  const content = responseJson.candidates[0].content.parts[0].text;
  return JSON.parse(content);
}

async function saveHeadlineData({ input_headline, flipped_headline, human_flipped_headline = '' }) {
  const params = {
    TableName: 'NewsFrames',
    Item: {
      headline_id: uuidv4(),
      input_headline,
      flipped_headline,
      human_flipped_headline,
      created_at: new Date().toISOString(),
    },
  };
  await docClient.put(params).promise();
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let headline;
  try {
    const { headline: h } = JSON.parse(event.body);
    headline = h;
    if (!headline) throw new Error();
  } catch {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Invalid or missing headline' }) };
  }

  // Agent 1: Detailed Frame Analysis
  const messages1 = [
  { role: 'system', content: `You are an advanced semantic news analysis agent specializing in cognitive frame analysis. Analyze the provided news headline to identify embedded cognitive frames.` },
  { role: 'developer', content: `Instructions:
1. Carefully parse the input headline: "${headline}".
2. Identify relevant cognitive frames (e.g., Conflict, Human Interest, Responsibility, Economic Consequences, Morality, Progress/Recovery).
3. For each frame, extract keywords, linguistic indicators (e.g., voice, metaphors), agent/patient roles, and contextual elements supporting the frame.
4. Your entire output MUST be a single, valid JSON object. Do NOT include any text, explanations, apologies, or markdown formatting outside of the JSON structure.

Required JSON Output Schema:
\`\`\`json
{
  "input_text": "The original headline text",
  "frames": [
    {
      "frame_type": "string (e.g., Conflict, Responsibility)",
      "keywords": ["string", "list"],
      "linguistic_indicators": "string (description of style/grammar)",
      "agent_patient_analysis": {
        "agent": "string (entity performing action, or N/A)",
        "patient": "string (entity affected by action, or N/A)"
      },
      "contextual_elements": "string (description of context)",
      "summary": "string (concise explanation of the frame's effect)"
    }
  ]
}
\`\`\`` },
  { role: 'user', content: `Analyze this headline: "${headline}"` }
];

  // Agent 2: Simplified Frame Decomposition
  const messages2 = [
    { role: 'system', content: `You are an expert in semantic news framing analysis. Decompose the news headline into its underlying semantic frames.` },
    { role: 'developer', content: `Instructions:
1. Analyze the headline: "${headline}".
2. Identify semantic frames (e.g., Conflict, Human Interest, Responsibility, Economic Consequences, Morality, Progress/Recovery).
3. For each frame, identify: Frame Type, Keywords, Agent, Action, Patient, and Contextual Cues. If a value is not explicitly present, use "N/A" or make a reasonable inference based on the text.
4. Your entire output MUST be a single, valid JSON object. Do NOT include any text, explanations, apologies, or markdown formatting outside of the JSON structure.

Required JSON Output Schema:
\`\`\`json
{
  "input_headline": "The original headline text",
  "frames": [
    {
      "frame_type": "string (e.g., Responsibility)",
      "keywords": ["string", "list"],
      "agent": "string (entity performing action, or N/A)",
      "action": "string (action performed, or N/A)",
      "patient": "string (entity affected, or N/A)",
      "contextual_cues": ["string", "list (relevant context words/phrases)"]
    }
  ]
}
\`\`\`` },
    { role: 'user', content: `Analyze this headline: "${headline}"` }
  ];

  // Run agents in parallel
  const [res1, res2] = await Promise.allSettled([
    callModel(messages1, 'gemini-1.5-flash-latest'),
    callModel(messages2, 'gemini-1.5-flash-latest')
  ]);

  const analysis1 = res1.status === 'fulfilled' ? res1.value : { error: res1.reason.message };
  const analysis2 = res2.status === 'fulfilled' ? res2.value : { error: res2.reason.message };

    // Agent 3: Synthesis and Comparison
  const messages3 = [
    { role: 'system', content: `You are a journalist with a PhD in media framing, sentiment analysis, and subliminal messaging.` },
    { role: 'developer', content: `Instructions:
1. Compare the identified frames, keywords, agent/patient roles, and overall interpretation in Analysis 1 and Analysis 2.
2. Highlight key similarities and differences in the framing identified by each analysis.
3. Output a flipped_headline presenting the same key information with an opposite frame. Add assumed info in [] if needed.
4. Your entire output MUST be a single, valid JSON object. Do NOT include any text, explanations, apologies, or markdown formatting outside of the JSON structure.

Required JSON Output Schema:
\`\`\`json
{
  "headline": "${headline}",
  "flipped_headline": "the same information presented in an opposite way",
  "key_similarities": [
    "string (Description of a similarity)",
    "..."
  ],
  "key_differences": [
    "string (Description of a difference)",
    "..."
  ],
  "agent1_had_error": ${res1.status !== 'fulfilled'},
  "agent2_had_error": ${res2.status !== 'fulfilled'}
}
\`\`\`` },
  { role: 'user', content: `Analysis1: ${JSON.stringify(analysis1)}
Analysis2: ${JSON.stringify(analysis2)}
Original: "${headline}"` }
  ];

  const synthesis = await callModel(messages3, 'gemini-1.5-flash-latest');

  // Save to DynamoDB
  await saveHeadlineData({ input_headline: headline, flipped_headline: synthesis.flipped_headline });

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ analysis_1: analysis1, analysis_2: analysis2, synthesis: synthesis })
  };
};
