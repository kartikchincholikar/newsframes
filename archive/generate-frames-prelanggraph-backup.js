const AWS = require('aws-sdk');
AWS.config.update({
  accessKeyId: process.env.ACCESS_KEY_ID,
  secretAccessKey: process.env.SECRET_ACCESS_KEY,
  region: process.env.REGION,
});

const docClient = new AWS.DynamoDB.DocumentClient();
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

/**
 * Attempts to extract and parse a JSON object from a string,
 * even if surrounded by other text or markdown fences.
 *
 * @param {string} text The raw text potentially containing JSON.
 * @returns {object | null} The parsed JSON object or null if parsing fails.
 */
function extractAndParseJson(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }

    // 1. Remove potential markdown fences and trim whitespace
    let cleanedText = text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();

    // 2. Find the first opening brace and the last closing brace
    const firstBrace = cleanedText.indexOf('{');
    const lastBrace = cleanedText.lastIndexOf('}');

    // 3. Check if a potential JSON object structure exists
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        // Extract the potential JSON string
        const potentialJson = cleanedText.substring(firstBrace, lastBrace + 1);

        // 4. Try parsing the extracted string
        try {
            return JSON.parse(potentialJson);
        } catch (e) {
            console.warn('JSON parse failed after extraction:', e.message, 'Extracted:', potentialJson);
            // Parsing failed even after extraction (likely malformed JSON)
            return null; // Indicate failure
        }
    } else {
        // No '{...}' structure found in the cleaned text
        return null; // Indicate failure
    }
}


// Improved model call function with robust JSON handling
async function callModel(messages, model = 'gemini-1.5-flash-latest') {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY');
  }

  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  // Convert MCP message format to Gemini format
  const contents = messages.map(msg => ({
    // Keep system/developer as user for Gemini for now, unless specific API docs advise otherwise
    role: msg.role === 'system' || msg.role === 'developer' ? 'user' : msg.role,
    parts: [{ text: msg.content }]
  }));

  const payload = {
    contents,
    generationConfig: {
      temperature: 0.5, // Adjust as needed
      maxOutputTokens: 2048, // Adjust as needed
      // Attempt to force JSON output if supported by the specific model/API version
      // Note: This might not always work or be supported. Client-side parsing is still essential.
      response_mime_type: "application/json"
    }
  };

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      // Attempt to read error details even on failure
      let errorText = `Status code ${res.status}`;
      try {
          const errorJson = await res.json(); // API might return JSON error details
          errorText = JSON.stringify(errorJson);
      } catch (e) {
          // If reading JSON fails, fall back to plain text
          try {
              errorText = await res.text();
          } catch (e2) { /* Ignore further errors */ }
      }
      console.error('Model API error:', res.status, errorText);
      // Try to provide a more informative error message if possible
      throw new Error(`Model API error: ${res.status}. Details: ${errorText.substring(0, 200)}`); // Limit length
    }

    const responseJson = await res.json();

    // Extract content from Gemini response using optional chaining
    const rawContent = responseJson?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (typeof rawContent !== 'string' || rawContent.trim() === '') {
        // Handle cases where content is missing, not a string, or empty after trim
        console.warn('Received empty or non-string content from model:', rawContent);
        // Decide if this is an error or just an empty valid response
        // Given the prompts demand JSON, treat this as an error state for parsing.
         return {
             error: "Model returned empty or invalid content",
             rawContent: rawContent || '' // Return raw content if available
         };
    }

    // Use the robust JSON extraction and parsing function
    const parsedJson = extractAndParseJson(rawContent);

    if (parsedJson !== null) {
        // Successfully parsed JSON
        return parsedJson;
    } else {
        // Failed to extract/parse JSON, even with the robust function
        console.error('Failed to parse JSON from model response despite robust attempt. Raw content:', rawContent);
        // Return an error object containing the raw content for debugging by the caller
        return {
            error: "Failed to parse JSON response from model",
            rawContent: rawContent
        };
        // --- OLD Fallback (Removed in favor of error object) ---
        // // Create a basic object with the content if JSON parsing fails
        // return {
        //   rawContent: rawContent, // Use the original cleaned content here
        //   flipped_headline: rawContent.includes('flipped_headline') ?
        //     rawContent.match(/["']flipped_headline["']\s*:\s*["']([^"']+)["']/)?.[1] || 'Alternative view unavailable' :
        //     'Alternative view unavailable'
        // };
    }

  } catch (error) {
    // Catch errors from fetch, initial response reading, or thrown errors
    console.error('Error calling model or processing response:', error);
    // Re-throw or return a structured error
     // Ensure error is an instance of Error for consistent handling downstream
     if (error instanceof Error) {
         throw error;
     } else {
         throw new Error(String(error));
     }
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
  
  try {
    await docClient.put(params).promise();
  } catch (error) {
    console.error('Error saving to DynamoDB:', error);
    throw new Error('Database error');
  }
}

exports.handler = async function(event) {
  const commonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  
  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: commonHeaders,
      body: JSON.stringify({ message: 'CORS preflight successful' })
    };
  }
  
  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      headers: commonHeaders, 
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }

  let headline;
  try {
    const body = JSON.parse(event.body || '{}');
    headline = body.headline;
    if (!headline || typeof headline !== 'string' || headline.trim() === '') {
      throw new Error('Invalid headline');
    }
  } catch (error) {
    return { 
      statusCode: 400, 
      headers: commonHeaders, 
      body: JSON.stringify({ error: 'Invalid or missing headline' }) 
    };
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

  // Run both analyses in parallel with proper error handling
  let analysis1, analysis2;
  try {
    const [res1, res2] = await Promise.allSettled([
      callModel(messages1),
      callModel(messages2)
    ]);
    
    analysis1 = res1.status === 'fulfilled' ? res1.value : { error: res1.reason?.message || "Analysis 1 failed" };
    analysis2 = res2.status === 'fulfilled' ? res2.value : { error: res2.reason?.message || "Analysis 2 failed" };
  } catch (err) {
    console.error('Parallel agent error:', err);
    return { 
      statusCode: 500, 
      headers: commonHeaders, 
      body: JSON.stringify({ error: 'Error running analysis agents' }) 
    };
  }

  // Agent 3: Synthesis and Comparison
  try {
    const agent1Failed = typeof analysis1 === 'object' && 'error' in analysis1;
    const agent2Failed = typeof analysis2 === 'object' && 'error' in analysis2;
    
    // Skip synthesis if both analyses failed
    if (agent1Failed && agent2Failed) {
      return {
        statusCode: 500,
        headers: commonHeaders,
        body: JSON.stringify({ 
          error: 'Both analysis agents failed',
          analysis_1: analysis1,
          analysis_2: analysis2
        })
      };
    }
    
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
  "agent1_had_error": ${agent1Failed},
  "agent2_had_error": ${agent2Failed}
}
\`\`\`` },
      { role: 'user', content: `Analysis1: ${JSON.stringify(analysis1)}
Analysis2: ${JSON.stringify(analysis2)}
Original: "${headline}"` }
    ];

    const synthesis = await callModel(messages3, 'gemini-1.5-flash-latest');

    // Replace the validation:
    if (!synthesis) {
      throw new Error('Empty synthesis result');
    }

    // Use optional chaining and fallback for flipped_headline
    const flippedHeadline = synthesis.flipped_headline || 
                            (typeof synthesis === 'string' ? synthesis : 'Alternative perspective unavailable');

    // Save to DynamoDB with the extracted headline
    await saveHeadlineData({ 
      input_headline: headline, 
      flipped_headline: flippedHeadline 
    });

    return {
      statusCode: 200,
      headers: commonHeaders,
      body: JSON.stringify({ 
        analysis_1: analysis1, 
        analysis_2: analysis2, 
        synthesis: synthesis 
      })
    };
  } catch (error) {
    console.error('Error in synthesis or database operation:', error);
    return { 
      statusCode: 500, 
      headers: commonHeaders, 
      body: JSON.stringify({ 
        error: 'Error in synthesis or database operation', 
        message: error.message,
        analysis_1: analysis1,
        analysis_2: analysis2
      }) 
    };
  }
};