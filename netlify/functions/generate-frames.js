const AWS = require('aws-sdk');
AWS.config.update({
  accessKeyId: process.env.ACCESS_KEY_ID,
  secretAccessKey: process.env.SECRET_ACCESS_KEY,
  region: process.env.REGION,
});

const docClient = new AWS.DynamoDB.DocumentClient();
const { v4: uuidv4 } = require('uuid');
// Use global fetch if available, otherwise fallback
const fetch = global.fetch || require('node-fetch');

// Generic model call using Model Context Protocol
async function callModel(messages, model = 'gemini-1.5-flash-latest') {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY');
  }
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const payload = {
    instances: [{ messages }],
    parameters: {
      temperature: 0.5,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
    },
  };

  let res, text;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    text = await res.text();
  } catch (networkErr) {
    console.error('Network error calling model API:', networkErr);
    throw new Error('Network error calling model API');
  }

  if (!res.ok) {
    console.error('Model API error:', res.status, text);
    throw new Error(`Model API responded with status ${res.status}`);
  }

  let responseJson;
  try {
    responseJson = JSON.parse(text);
  } catch (parseErr) {
    console.error('Invalid JSON from model API:', parseErr, text);
    throw new Error('Invalid JSON from model API');
  }

  const candidate = responseJson.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!candidate) {
    console.error('Unexpected model API structure:', JSON.stringify(responseJson));
    throw new Error('Unexpected model API response format');
  }

  try {
    return JSON.parse(candidate);
  } catch (innerErr) {
    console.error('Failed to parse model output:', innerErr, candidate);
    throw new Error('Model output is not valid JSON');
  }
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
  return docClient.put(params).promise();
}

exports.handler = async function(event, context) {
  const commonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: commonHeaders, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let headline;
  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    headline = body.headline;
    if (!headline) throw new Error();
  } catch {
    return { statusCode: 400, headers: commonHeaders, body: JSON.stringify({ error: 'Invalid or missing headline' }) };
  }

  // Prepare agents
  const messages1 = [
    { role: 'system', content: 'You are an advanced semantic news analysis agent specializing in cognitive frame analysis.' },
    { role: 'developer', content: `Instructions: 1. Parse: "${headline}" 2. Identify frames 3. Extract keywords, indicators, roles, context. 4. Output valid JSON only. Schema: { input_text, frames:[{frame_type, keywords, linguistic_indicators, agent_patient_analysis:{agent,patient}, contextual_elements, summary}] }` },
    { role: 'user', content: `Analyze this headline: "${headline}"` }
  ];

  const messages2 = [
    { role: 'system', content: 'You are an expert in semantic news framing analysis.' },
    { role: 'developer', content: `Instructions: 1. Parse: "${headline}" 2. Identify frames and for each: frame_type, keywords, agent, action, patient, contextual_cues. 3. Output valid JSON only. Schema: { input_headline, frames:[{frame_type, keywords, agent, action, patient, contextual_cues}] }` },
    { role: 'user', content: `Decompose this headline: "${headline}"` }
  ];

  let analysis1, analysis2;
  try {
    const [res1, res2] = await Promise.allSettled([
      callModel(messages1),
      callModel(messages2)
    ]);
    analysis1 = res1.status === 'fulfilled' ? res1.value : { error: res1.reason.message };
    analysis2 = res2.status === 'fulfilled' ? res2.value : { error: res2.reason.message };
  } catch (err) {
    console.error('Parallel agent error:', err);
    return { statusCode: 500, headers: commonHeaders, body: JSON.stringify({ error: 'Error running analysis agents' }) };
  }

  // Synthesis
  const messages3 = [
    { role: 'system', content: 'You are a journalist with a PhD in media framing, sentiment analysis, and subliminal messaging.' },
    { role: 'developer', content: `Instructions: Compare analyses, list similarities/differences, produce flipped_headline opposite framing. Output valid JSON only. Schema: { headline, flipped_headline, key_similarities, key_differences, agent1_had_error, agent2_had_error }` },
    { role: 'user', content: `Analysis1: ${JSON.stringify(analysis1)}\nAnalysis2: ${JSON.stringify(analysis2)}\nOriginal: "${headline}"` }
  ];

  let synthesis;
  try {
    synthesis = await callModel(messages3);
  } catch (err) {
    console.error('Synthesis error:', err);
    synthesis = { error: err.message };
  }

  // Persist data (errors allowed)
  saveHeadlineData({ input_headline: headline, flipped_headline: synthesis.flipped_headline || '' }).catch(err => console.error('Save error:', err));

  return {
    statusCode: 200,
    headers: commonHeaders,
    body: JSON.stringify({ analysis_1: analysis1, analysis_2: analysis2, synthesis: synthesis })
  };
};
