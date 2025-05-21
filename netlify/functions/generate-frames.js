const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const { StateGraph, END } = require('@langchain/langgraph');

// AWS Configuration
AWS.config.update({
  accessKeyId: process.env.ACCESS_KEY_ID,
  secretAccessKey: process.env.SECRET_ACCESS_KEY,
  region: process.env.REGION,
});
const docClient = new AWS.DynamoDB.DocumentClient();

// --- Utility Functions --- (extractAndParseJson, callModel, saveHeadlineData - unchanged from previous correct version)
function extractAndParseJson(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }
    let cleanedText = text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
    const firstBrace = cleanedText.indexOf('{');
    const lastBrace = cleanedText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const potentialJson = cleanedText.substring(firstBrace, lastBrace + 1);
        try {
            return JSON.parse(potentialJson);
        } catch (e) {
            console.warn('JSON parse failed after extraction:', e.message, 'Extracted:', potentialJson.substring(0, 200));
            return null;
        }
    }
    return null;
}

async function callModel(messages, model = 'gemini-1.5-flash-latest') {
  if (!process.env.GEMINI_API_KEY) {
    return { error: 'Missing GEMINI_API_KEY', rawContent: '' };
  }
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const contents = messages.map(msg => ({
    role: msg.role === 'system' || msg.role === 'developer' ? 'user' : msg.role,
    parts: [{ text: msg.content }]
  }));
  const payload = {
    contents,
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 2048,
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
      let errorText = `Status code ${res.status}`;
      try {
          const errorJson = await res.json(); 
          errorText = JSON.stringify(errorJson);
      } catch (e) {
          try { errorText = await res.text(); } catch (e2) { /* Ignore */ }
      }
      console.error('Model API error:', res.status, errorText);
      return { error: `Model API error: ${res.status}. Details: ${errorText.substring(0, 200)}`, rawContent: '' };
    }
    const responseJson = await res.json();
    const rawContent = responseJson?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof rawContent !== 'string' || rawContent.trim() === '') {
        console.warn('Received empty or non-string content from model:', rawContent);
         return {
             error: "Model returned empty or invalid content",
             rawContent: rawContent || ''
         };
    }
    const parsedJson = extractAndParseJson(rawContent);
    if (parsedJson !== null) {
        return parsedJson;
    } else {
        console.error('Failed to parse JSON from model response. Raw content:', rawContent.substring(0, 500));
        return {
            error: "Failed to parse JSON response from model",
            rawContent: rawContent
        };
    }
  } catch (error) {
    console.error('Error calling model or processing response:', error);
    return { error: `Network or unexpected error in callModel: ${error.message}`, rawContent: '' };
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
    return { success: true };
  } catch (error) {
    console.error('Error saving to DynamoDB:', error);
    return { success: false, message: 'Database error: ' + error.message };
  }
}

// --- LangGraph State Definition --- (unchanged)
/**
 * @typedef {object} AppState
 * @property {string} [input_headline]
 * @property {object | {error: string, rawContent?: string}} [analysis1_result]
 * @property {object | {error: string, rawContent?: string}} [analysis2_result]
 * @property {object | {error: string, rawContent?: string}} [synthesis_result]
 * @property {string} [flipped_headline]
 * @property {{success: boolean, message?: string}} [db_save_status]
 * @property {string} [error_message] General error from graph execution.
 */

// --- LangGraph Nodes --- (runAnalyzersInParallelNode, synthesisNode, saveToDynamoDBNode - unchanged)
async function runAnalyzersInParallelNode(state) {
    console.log("--- Running Analyzers in Parallel Node ---");
    const headline = state.input_headline;
    const messages1 = [
      { role: 'system', content: "You are an AI assistant. Analyze the headline for cognitive frames. Output ONLY valid JSON." },
      { role: 'developer', content: `Instructions: Analyze the provided headline to identify embedded cognitive frames. Required JSON Output Schema: \`\`\`json { "input_text": "...", "frames": [{ "frame_type": "...", "keywords": [], "linguistic_indicators": "...", "agent_patient_analysis": {"agent": "...", "patient": "..."}, "contextual_elements": "...", "summary": "..."}] } \`\`\`` },
      { role: 'user', content: `Analyze this headline: "${headline}"` }
    ];
    const messages2 = [
      { role: 'system', content: "You are an AI assistant. Decompose the headline into semantic frames. Output ONLY valid JSON." },
      { role: 'developer', content: `Instructions: Analyze the headline for semantic frames. Required JSON Output Schema: \`\`\`json { "input_headline": "...", "frames": [{"frame_type": "...", "keywords": [], "agent": "...", "action": "...", "patient": "...", "contextual_cues": []}] } \`\`\`` },
      { role: 'user', content: `Analyze this headline: "${headline}"` }
    ];
    const [res1, res2] = await Promise.allSettled([
      callModel(messages1),
      callModel(messages2)
    ]);
    const analysis1_result = res1.status === 'fulfilled' ? res1.value : { error: res1.reason?.message || "Analysis 1 (Detailed) failed", rawContent: '' };
    const analysis2_result = res2.status === 'fulfilled' ? res2.value : { error: res2.reason?.message || "Analysis 2 (Simplified) failed", rawContent: '' };
    return { analysis1_result, analysis2_result };
}

async function synthesisNode(state) {
  console.log("--- Running Synthesis Node ---");
  const { input_headline, analysis1_result, analysis2_result } = state;
  const agent1Failed = !!(analysis1_result && analysis1_result.error);
  const agent2Failed = !!(analysis2_result && analysis2_result.error);
  if (agent1Failed && agent2Failed) {
    console.warn("Both analysis agents failed. Synthesis may be limited.");
  }
  const messages3 = [
    { role: 'system', content: "You are an AI assistant. Synthesize analyses, compare them, and generate a flipped headline. Output ONLY valid JSON." },
    { role: 'developer', content: `Instructions: Compare analyses, highlight similarities/differences, output a "flipped_headline". Required JSON Output Schema: \`\`\`json { "headline": "${input_headline}", "flipped_headline": "...", "key_similarities": [], "key_differences": [], "agent1_had_error": ${agent1Failed}, "agent2_had_error": ${agent2Failed} } \`\`\`` },
    { role: 'user', content: `Original Headline: "${input_headline}"\nAnalysis1: ${JSON.stringify(analysis1_result)}\nAnalysis2: ${JSON.stringify(analysis2_result)}` }
  ];
  const synthesis_result = await callModel(messages3);
  let flipped_headline = 'Alternative perspective unavailable (synthesis error or not found)';
  if (synthesis_result && !synthesis_result.error && typeof synthesis_result.flipped_headline === 'string') {
    flipped_headline = synthesis_result.flipped_headline;
  } else if (synthesis_result && synthesis_result.error) {
    flipped_headline = `Alternative perspective unavailable (Error: ${synthesis_result.error})`;
  } else if (typeof synthesis_result === 'object' && synthesis_result !== null && !synthesis_result.flipped_headline) {
     flipped_headline = 'Alternative perspective unavailable (flipped_headline field missing)';
  } else if (typeof synthesis_result !== 'object' && synthesis_result !== null) {
     flipped_headline = `Alternative perspective unavailable (Unexpected synthesis output type)`;
  }
  return { synthesis_result, flipped_headline };
}

async function saveToDynamoDBNode(state) {
  console.log("--- Running Save to DynamoDB Node ---");
  const { input_headline, flipped_headline } = state;
  if (!input_headline || typeof flipped_headline !== 'string') {
    console.warn("Missing input_headline or valid flipped_headline for DB save. Skipping.");
    return { db_save_status: { success: false, message: "Missing data or invalid flipped_headline for DB save" } };
  }
  const cleanFlippedHeadline = flipped_headline.startsWith("Alternative perspective unavailable") ? 
                                "Alternative perspective unavailable" : flipped_headline;
  const status = await saveHeadlineData({
    input_headline,
    flipped_headline: cleanFlippedHeadline
  });
  return { db_save_status: status };
}

// --- LangGraph Workflow Definition --- (appStateChannels, appGraph, app - unchanged)
const appStateChannels = {
    input_headline: { value: (x, y) => y, default: () => undefined },
    analysis1_result: { value: (x, y) => y, default: () => undefined },
    analysis2_result: { value: (x, y) => y, default: () => undefined },
    synthesis_result: { value: (x, y) => y, default: () => undefined },
    flipped_headline: { value: (x, y) => y, default: () => undefined },
    db_save_status: { value: (x, y) => y, default: () => undefined },
    error_message: { value: (x, y) => y, default: () => undefined },
};
const appGraph = new StateGraph({ channels: appStateChannels });
appGraph.addNode("parallel_analyzers", runAnalyzersInParallelNode);
appGraph.addNode("synthesizer", synthesisNode);
appGraph.addNode("saver", saveToDynamoDBNode);
appGraph.setEntryPoint("parallel_analyzers");
appGraph.addEdge("parallel_analyzers", "synthesizer");
appGraph.addEdge("synthesizer", "saver");
appGraph.addEdge("saver", END);
const app = appGraph.compile();


// --- Netlify Handler ---
exports.handler = async function(event) {
  const commonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*', 
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: commonHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: commonHeaders, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let headline;
  try {
    const body = JSON.parse(event.body || '{}');
    headline = body.headline;
    if (!headline || typeof headline !== 'string' || headline.trim() === '') {
      throw new Error('Headline is required and must be a non-empty string.');
    }
  } catch (error) {
    return { statusCode: 400, headers: commonHeaders, body: JSON.stringify({ error: 'Invalid request: ' + error.message }) };
  }

  // Define the graph structure for the frontend
  // This structure dictates how the frontend visualizes the graph stages and nodes.
  // 'id' should be unique for DOM elements.
  // 'detailsKey' maps to the key in the `data` payload for showing details.
  // 'statusKey' maps to the key in the `data` payload for checking error/success.
  const graphStructure = {
    nodes: [ // This array represents sequential stages of the graph
      {
        id: "input_display", // Unique ID for this display element
        displayName: "Input Headline",
        type: "input", // Special type for the initial input
        detailsKey: "input_headline", // The key in `data` for its details
        statusKey: "input_headline"   // The key in `data` to check its status (presence)
      },
      {
        id: "parallel_analyzers_stage", // ID for the stage itself
        type: "parallel-group", // Indicates this stage has multiple sub-elements
        subNodes: [ // The actual conceptual nodes displayed in parallel
          { id: "analysis1", displayName: "1a. Detailed Analysis", detailsKey: "raw_analysis1", statusKey: "raw_analysis1" },
          { id: "analysis2", displayName: "1b. Simplified Analysis", detailsKey: "raw_analysis2", statusKey: "raw_analysis2" }
        ]
      },
      {
        id: "synthesizer_display", 
        displayName: "2. Synthesizer",
        type: "sequential", // A standard sequential node/stage
        detailsKey: "synthesis_details",
        statusKey: "synthesis_details"
      },
      {
        id: "saver_display",
        displayName: "3. Save to DB",
        type: "sequential",
        detailsKey: "db_save_status",
        statusKey: "db_save_status" // db_save_status has a .success boolean
      }
    ]
  };

  const initialState = { input_headline: headline };

  try {
    console.log("Invoking LangGraph app with state:", initialState);
    const finalState = await app.invoke(initialState, { recursionLimit: 10 });
    console.log("LangGraph app finished.");

    const responsePayload = {
        input_headline: finalState.input_headline,
        flipped_headline: finalState.flipped_headline,
        synthesis_details: finalState.synthesis_result,
        // Keep raw_analysis1/2 keys as used by frontend's detailsKey/statusKey
        raw_analysis1: finalState.analysis1_result, 
        raw_analysis2: finalState.analysis2_result,
        db_save_status: finalState.db_save_status,
    };
    
    let overallStatusMessage = "Processing successful";
    let httpStatusCode = 200;

    if (finalState.analysis1_result?.error && finalState.analysis2_result?.error) {
        overallStatusMessage = "Both analysis steps failed.";
    } else if (finalState.synthesis_result?.error || (finalState.flipped_headline && finalState.flipped_headline.startsWith("Alternative perspective unavailable (Error:"))) {
        overallStatusMessage = "Synthesis failed or encountered an error.";
    } else if (finalState.db_save_status && !finalState.db_save_status.success) {
        overallStatusMessage = "Processing completed, but failed to save results to database.";
    }

    return {
      statusCode: httpStatusCode,
      headers: commonHeaders,
      body: JSON.stringify({
        message: overallStatusMessage,
        data: responsePayload,
        graphStructure: graphStructure // Send the structure to the frontend
      }),
    };

  } catch (graphError) {
    console.error('LangGraph execution error:', graphError);
    return {
      statusCode: 500,
      headers: commonHeaders,
      body: JSON.stringify({
        error: 'Graph execution failed unexpectedly.',
        details: graphError.message,
        input_headline: headline,
        graphStructure: graphStructure // Also send structure on error for potential partial display
      }),
    };
  }
};