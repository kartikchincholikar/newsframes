const fetch = require('node-fetch');

// Helper function to call the Gemini API and expect structured JSON output
async function callAgent(prompt, agentName = 'Agent') {
  const API_KEY = process.env.GEMINI_API_KEY;
  // Using a newer model version might yield better structured output adherence.
  // Consider gemini-1.5-flash-latest or gemini-1.5-pro-latest if available and suitable.
  const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent"; // Example: Using 1.5 Flash

  console.log(`[${agentName}] Sending prompt...`); // Log which agent is called

  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.5, // Lower temperature might help with consistency for structured output
      maxOutputTokens: 2048, // Increased tokens might be needed for complex JSON
      // Instruct the API to return JSON
      response_mime_type: "application/json",
    }
  };

  try {
    const response = await fetch(`${API_URL}?key=${API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    const responseText = await response.text(); // Get text first for logging in case of failure

    if (!response.ok) {
      console.error(`[${agentName}] API Error Status:`, response.status);
      console.error(`[${agentName}] API Error Response:`, responseText);
      throw new Error(`[${agentName}] API request failed with status ${response.status}`);
    }

    // Log the raw response text before parsing
    // console.log(`[${agentName}] Raw API Response Text:`, responseText);

    // Attempt to parse the JSON response directly
    // Gemini with response_mime_type="application/json" should return pure JSON text
    const data = JSON.parse(responseText);

    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content ||
        !data.candidates[0].content.parts || !data.candidates[0].content.parts[0].text) {
      console.error(`[${agentName}] Unexpected API response format:`, JSON.stringify(data));
      throw new Error(`[${agentName}] Unexpected API response format`);
    }

    // The actual JSON content is nested within the response structure
    const jsonOutputText = data.candidates[0].content.parts[0].text;

    // Parse the JSON string provided by the model
    try {
      const parsedJson = JSON.parse(jsonOutputText);
      console.log(`[${agentName}] Successfully parsed JSON output.`);
      return parsedJson; // Return the parsed JavaScript object
    } catch (parseError) {
      console.error(`[${agentName}] Failed to parse JSON output from model:`, parseError);
      console.error(`[${agentName}] Model Output Text was:`, jsonOutputText);
      throw new Error(`[${agentName}] Model failed to return valid JSON. Output: ${jsonOutputText}`);
    }

  } catch (error) {
    console.error(`[${agentName}] Error during API call or processing:`, error);
    // Re-throw the error to be caught by the main handler
    throw error; // Propagate the error
  }
}


exports.handler = async function(event, context) {
  try {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Method Not Allowed' })
      };
    }

    // Parse the incoming request body
    let headline;
    try {
        const body = JSON.parse(event.body);
        headline = body.headline;
        if (!headline) {
            throw new Error('Headline is required');
        }
    } catch (e) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ error: 'Invalid JSON body or missing headline' })
        };
    }


    // === Agent 1: Detailed Frame Analysis ===
    const systemPrompt1 = `
You are an advanced semantic news analysis agent specializing in cognitive frame analysis.
Analyze the provided news headline to identify embedded cognitive frames.

**Instructions:**
1.  Carefully parse the input headline: "${headline}".
2.  Identify relevant cognitive frames (e.g., Conflict, Human Interest, Responsibility, Economic Consequences, Morality, Progress/Recovery).
3.  For each frame, extract keywords, linguistic indicators (e.g., voice, metaphors), agent/patient roles, and contextual elements supporting the frame.
4.  Your *entire output* MUST be a single, valid JSON object. Do NOT include any text, explanations, apologies, or markdown formatting outside of the JSON structure.

**Required JSON Output Schema:**
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
    // Add more frame objects if multiple frames are identified
  ]
}
\`\`\`

Analyze this headline: "${headline}"`;

    // === Agent 2: Simplified Frame Decomposition ===
    const systemPrompt2 = `
You are an expert in semantic news framing analysis.
Decompose the news headline into its underlying semantic frames.

**Instructions:**
1.  Analyze the headline: "${headline}".
2.  Identify semantic frames (e.g., Conflict, Human Interest, Responsibility, Economic Consequences, Morality, Progress/Recovery).
3.  For each frame, identify: Frame Type, Keywords, Agent, Action, Patient, and Contextual Cues. If a value is not explicitly present, use "N/A" or make a reasonable inference based on the text.
4.  Your *entire output* MUST be a single, valid JSON object. Do NOT include any text, explanations, apologies, or markdown formatting outside of the JSON structure.

**Required JSON Output Schema:**
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
    // Add more frame objects if multiple frames are identified
  ]
}
\`\`\`

Analyze this headline: "${headline}"`;

    // Run the two parallel agents concurrently.
    // Use Promise.allSettled to handle potential failures in one agent without stopping the other.
    const results = await Promise.allSettled([
      callAgent(systemPrompt1, 'Agent 1'),
      callAgent(systemPrompt2, 'Agent 2')
    ]);

    const analysis1Result = results[0];
    const analysis2Result = results[1];

    // Prepare results for the synthesis agent, handling potential errors
    const analysis1Json = analysis1Result.status === 'fulfilled' ? analysis1Result.value : { error: `Agent 1 failed: ${analysis1Result.reason?.message || 'Unknown error'}` };
    const analysis2Json = analysis2Result.status === 'fulfilled' ? analysis2Result.value : { error: `Agent 2 failed: ${analysis2Result.reason?.message || 'Unknown error'}` };

    // === Agent 3: Synthesis and Comparison ===
    const sequentialPrompt = `
You are an journalist with a phd in media framing and sentiment analysis and subliminal messaging.
You are given two JSON objects representing frame analyses of the same headline, potentially generated by semantic and cognitive methods.

**Analysis 1:**
\`\`\`json
${JSON.stringify(analysis1Json, null, 2)}
\`\`\`

**Analysis 2:**
\`\`\`json
${JSON.stringify(analysis2Json, null, 2)}
\`\`\`

**Instructions:**
1.  Compare the identified frames, keywords, agent/patient roles, and overall interpretation in Analysis 1 and Analysis 2.
2.  Highlight key similarities and differences in the framing identified by each analysis.
3.  Provide a concise synthesis of the findings.
4.  Now try to output a headline which has a completely different frame, but the same key information. Please add additional assumed info in [] if required.
5.  Your *entire output* MUST be a single, valid JSON object. Do NOT include any text, explanations, apologies, or markdown formatting outside of the JSON structure.

**Required JSON Output Schema:**
\`\`\`json
{
  "headline": "${headline}",
  "flipped-headline": "the same information presented in an opposite way"
}
\`\`\`

Generate the comparison JSON object.`;

    // Sequential call for synthesis.
    // This call also expects structured JSON output.
    const synthesisResultJson = await callAgent(sequentialPrompt, 'Agent 3 (Synthesis)');

    // Return the structured results from all agents
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', // Adjust CORS as needed
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify({
        // analysis_1: analysis1Json, // Contains either parsed JSON or error object
        // analysis_2: analysis2Json, // Contains either parsed JSON or error object
        synthesis: synthesisResultJson // Contains parsed JSON from synthesis agent
      })
    };

  } catch (error) {
    console.error('Handler Error:', error);
    // Determine if the error came from an agent or elsewhere
    const errorMessage = error.message || 'An internal error occurred.';
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', // Adjust CORS as needed
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify({
        error: 'Internal Server Error',
        message: errorMessage
      })
    };
  }
};