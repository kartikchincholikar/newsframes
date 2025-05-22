const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const { StateGraph, END } = require('@langchain/langgraph');

// --- AWS Configuration ---
AWS.config.update({
  accessKeyId: process.env.ACCESS_KEY_ID,
  secretAccessKey: process.env.SECRET_ACCESS_KEY,
  region: process.env.REGION,
});
const docClient = new AWS.DynamoDB.DocumentClient();

// --- Utility Functions (mostly unchanged) ---

/**
 * Attempts to extract and parse a JSON object from a string.
 * @param {string} text The raw text potentially containing JSON.
 * @returns {object | null} The parsed JSON object or null if parsing fails.
 */
function extractAndParseJson(text) {
  // ... (keep your existing extractAndParseJson function here)
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
            console.warn('JSON parse failed after extraction:', e.message, 'Extracted:', potentialJson);
            return null;
        }
    } else {
        return null;
    }
}


/**
 * Calls the generative model API.
 * @param {Array<object>} messages Array of message objects for the model.
 * @param {string} model Model ID.
 * @returns {Promise<object>} Parsed JSON response or an error object.
 */
async function callModel(messages, model = 'gemini-1.5-flash-latest') {
  // ... (keep your existing callModel function here, it's well-structured)
  if (!process.env.GEMINI_API_KEY) {
    // This will be caught by the node and propagated in the state
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
        console.error('Failed to parse JSON from model response. Raw content:', rawContent);
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

/**
 * Saves headline data to DynamoDB.
 * @param {object} data Data to save.
 * @param {string} data.input_headline
 * @param {string} data.flipped_headline
 * @param {string} [data.human_flipped_headline='']
 * @returns {Promise<{success: boolean, message?: string}>}
 */
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

// --- LangGraph State Definition (using JSDoc for clarity) ---
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

// --- LangGraph Nodes ---

async function detailedAnalyzerNode(state) {
  console.log("--- Running Detailed Analyzer Node ---");
  const headline = state.input_headline;
  const messages1 = [
    { role: 'system', content: `You are an advanced semantic news analysis agent specializing in cognitive frame analysis. Analyze the provided news headline to identify embedded cognitive frames.` },
    { role: 'developer', content: `Instructions: (...) Required JSON Output Schema: (...)` }, // Keep your full prompt
    { role: 'user', content: `Analyze this headline: "${headline}"` }
  ];
  const result = await callModel(messages1);
  return { analysis1_result: result };
}

async function simplifiedAnalyzerNode(state) {
  console.log("--- Running Simplified Analyzer Node ---");
  const headline = state.input_headline;
  const messages2 = [
    { role: 'system', content: `You are an expert in semantic news framing analysis. Decompose the news headline into its underlying semantic frames.` },
    { role: 'developer', content: `Instructions: (...) Required JSON Output Schema: (...)` }, // Keep your full prompt
    { role: 'user', content: `Analyze this headline: "${headline}"` }
  ];
  const result = await callModel(messages2);
  return { analysis2_result: result };
}

async function synthesisNode(state) {
  console.log("--- Running Synthesis Node ---");
  const { input_headline, analysis1_result, analysis2_result } = state;

  const agent1Failed = analysis1_result && 'error' in analysis1_result;
  const agent2Failed = analysis2_result && 'error' in analysis2_result;

  // If both primary analyses failed, we might not want to proceed or pass minimal info
  if (agent1Failed && agent2Failed) {
    console.warn("Both analysis agents failed. Skipping synthesis or providing minimal data.");
    // You could return early or try to synthesize with what you have (error messages)
    // For now, let's proceed, the LLM might still be able to comment on the failures.
  }

  const messages3 = [
    { role: 'system', content: `You are a journalist with a PhD in media framing, sentiment analysis, and subliminal messaging. Your job is to flip headlines.` },
    { role: 'developer', content: `Instructions:
      
1. Compare the identified frames, keywords, agent/patient roles, and overall interpretation in Analysis 1 and Analysis 2.
2. Highlight key similarities and differences in the framing identified by each analysis.
3. Output a flipped_headline presenting the same key information with an opposite frame. Add assumed info in [] if needed.
4. Your entire output MUST be a single, valid JSON object. Do NOT include any text, explanations, apologies, or markdown formatting outside of the JSON structure.

Required JSON Output Schema:
\`\`\`json
{
  "headline": "${input_headline}",
  "flipped_headline": "the same information presented in an opposite way",
  "key_similarities": ["string (Description of a similarity)", "..."],
  "key_differences": ["string (Description of a difference)", "..."],
  "agent1_had_error": ${agent1Failed},
  "agent2_had_error": ${agent2Failed}
}
\`\`\`` },
    { role: 'user', content: `Analysis1: ${JSON.stringify(analysis1_result)}
Analysis2: ${JSON.stringify(analysis2_result)}
Original: "${input_headline}"` }
  ];

  const synthesis_result = await callModel(messages3, 'gemini-1.5-flash-latest');
  let flipped_headline = 'Alternative perspective unavailable (synthesis error or not found)';

  if (synthesis_result && !synthesis_result.error && synthesis_result.flipped_headline) {
    flipped_headline = synthesis_result.flipped_headline;
  } else if (synthesis_result && synthesis_result.error) {
    flipped_headline = `Alternative perspective unavailable (Error: ${synthesis_result.error})`;
  } else if (typeof synthesis_result === 'string') { // Fallback if JSON parsing failed but got string
    flipped_headline = synthesis_result;
  }

  return { synthesis_result, flipped_headline };
}

async function saveToDynamoDBNode(state) {
  console.log("--- Running Save to DynamoDB Node ---");
  const { input_headline, flipped_headline } = state;

  if (!input_headline || !flipped_headline) {
    console.warn("Missing input_headline or flipped_headline for DB save. Skipping.");
    return { db_save_status: { success: false, message: "Missing data for DB save" } };
  }
  
  // Ensure flipped_headline isn't an error message itself if possible, or decide how to store it
  const cleanFlippedHeadline = flipped_headline.startsWith("Alternative perspective unavailable") ? 
                                "Alternative perspective unavailable" : flipped_headline;

  const status = await saveHeadlineData({
    input_headline,
    flipped_headline: cleanFlippedHeadline
  });
  return { db_save_status: status };
}


// --- LangGraph Workflow Definition ---
const workflow = new StateGraph({
  channels: {
    input_headline: { value: (x, y) => y, default: () => undefined },
    analysis1_result: { value: (x, y) => y, default: () => undefined },
    analysis2_result: { value: (x, y) => y, default: () => undefined },
    synthesis_result: { value: (x, y) => y, default: () => undefined },
    flipped_headline: { value: (x, y) => y, default: () => undefined },
    db_save_status: { value: (x, y) => y, default: () => undefined },
    error_message: { value: (x, y) => y, default: () => undefined },
  }
});

// Add nodes
workflow.addNode("detailed_analyzer", detailedAnalyzerNode);
workflow.addNode("simplified_analyzer", simplifiedAnalyzerNode);
workflow.addNode("synthesizer", synthesisNode);
workflow.addNode("saver", saveToDynamoDBNode);

// Define edges
workflow.setEntryPoint("detailed_analyzer"); // Start one branch
workflow.addConditionalEdges( // Also start the other branch from entry
    "detailed_analyzer", 
    () => "simplified_analyzer", // Always go to simplified_analyzer next in this "branch"
    { "simplified_analyzer": "simplified_analyzer" } // Dummy map, just to make it run
);

workflow.setEntryPoint("detailed_analyzer"); // Entry point for one branch

// Resetting edges for clarity:
workflow.setEntryPoint("detailed_analyzer");
workflow.addEdge("detailed_analyzer", "synthesizer"); // Will wait for simplified_analyzer too if it's also an input


workflow.addNode("start_node_placeholder", (state) => {
    console.log("--- Starting Parallel Analyses ---");
    return {}; // No state change, just a branching point
});
workflow.setEntryPoint("start_node_placeholder");

// This creates two independent branches that `synthesizer` will implicitly wait for
workflow.addEdge("start_node_placeholder", "detailed_analyzer");
workflow.addEdge("start_node_placeholder", "simplified_analyzer");


workflow.addEdge("detailed_analyzer", "synthesizer");
workflow.addEdge("simplified_analyzer", "synthesizer");


// Let's use a slightly different graph structure for clarity on parallelism:
// We'll create a "parallel_analyzers" meta-node.
const parallelWorkflow = new StateGraph({ channels: { /* as above */ } });
parallelWorkflow.addNode("detailed_analyzer_p", detailedAnalyzerNode);
parallelWorkflow.addNode("simplified_analyzer_p", simplifiedAnalyzerNode);
parallelWorkflow.setEntryPoint("detailed_analyzer_p");
parallelWorkflow.addEdge("detailed_analyzer_p", "simplified_analyzer_p"); // This makes them sequential within this sub-graph
parallelWorkflow.addEdge("simplified_analyzer_p", END);
// This sub-graph isn't truly parallel.


async function runAnalyzersInParallel(state) {
    console.log("--- Running Analyzers in Parallel (simulated) ---");
    const headline = state.input_headline;
    const messages1 = [ { role: 'system', content: `You are an expert agent for analysing news frames and news headline.`},
       { role: 'developer', content: `Instructions:
1. Carefully analyze the input headline: "${headline}".
3. Slow violence/fast violance, Euphemism, Schizo twist, Math Frames

4. Your entire output MUST be a single, valid JSON object. Do NOT include any text, explanations, apologies, or markdown formatting outside of the JSON structure.

Required JSON Output Schema:
\`\`\`json
{
  "framing_detected": "True"
  "frame_scale": "9",
  "explaination": 9/10 because it is clearly doing this,


  "input_text": "The original headline text",
  "frames": [
    {
      "frame_type": "string (e.g., Conflict, Responsibility)",
      "keywords": ["string", "list"],

    }
  ]
}
\`\`\`` },{ role: 'user', content: `Analyze this headline: "${headline}"` } ];
    const messages2 = [ /* ... as in simplifiedAnalyzerNode ... */ { role: 'system', content: `You are an expert in semantic news framing analysis. Decompose the news headline into its underlying semantic frames.` },{ role: 'developer', content: `Instructions:
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
\`\`\`` },{ role: 'user', content: `Analyze this headline: "${headline}"` } ];

    const [res1, res2] = await Promise.allSettled([
      callModel(messages1),
      callModel(messages2)
    ]);

    const analysis1_result = res1.status === 'fulfilled' ? res1.value : { error: res1.reason?.message || "Analysis 1 failed", rawContent: '' };
    const analysis2_result = res2.status === 'fulfilled' ? res2.value : { error: res2.reason?.message || "Analysis 2 failed", rawContent: '' };
    
    return { analysis1_result, analysis2_result };
}

// New Graph Structure:
const appGraph = new StateGraph({
  channels: { /* same channels as defined before */
    input_headline: { value: (x, y) => y, default: () => undefined },
    analysis1_result: { value: (x, y) => y, default: () => undefined },
    analysis2_result: { value: (x, y) => y, default: () => undefined },
    synthesis_result: { value: (x, y) => y, default: () => undefined },
    flipped_headline: { value: (x, y) => y, default: () => undefined },
    db_save_status: { value: (x, y) => y, default: () => undefined },
    error_message: { value: (x, y) => y, default: () => undefined },
  }
});

appGraph.addNode("parallel_analyzers", runAnalyzersInParallel);
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
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: commonHeaders, body: JSON.stringify({ message: 'CORS preflight successful' }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: commonHeaders, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let headline;
  try {
    const body = JSON.parse(event.body || '{}');
    headline = body.headline;
    if (!headline || typeof headline !== 'string' || headline.trim() === '') {
      throw new Error('Invalid headline');
    }
  } catch (error) {
    return { statusCode: 400, headers: commonHeaders, body: JSON.stringify({ error: 'Invalid or missing headline' }) };
  }

  const initialState = { input_headline: headline };

  try {
    console.log("Invoking LangGraph app with state:", initialState);
    const finalState = await app.invoke(initialState, { recursionLimit: 10 });
    console.log("LangGraph app finished. Final state:", finalState);

    // Check for major failures propagated from nodes
    let overallError = null;
    if (finalState.analysis1_result?.error && finalState.analysis2_result?.error) {
        overallError = "Both analysis agents failed.";
    } else if (finalState.synthesis_result?.error) {
        overallError = `Synthesis failed: ${finalState.synthesis_result.error}`;
    }
    // Add more checks as needed, e.g., DB save failure

    if (overallError) {
        // Decide if this should be a 500 or a 200 with error details
        // For now, returning 200 but with the structured errors from the graph
        return {
            statusCode: 200, // Or 500 if you prefer for partial failures
            headers: commonHeaders,
            body: JSON.stringify({
                message: "Processing completed with some errors.",
                graph_output: finalState,
                error_summary: overallError
            })
        };
    }

    return {
      statusCode: 200,
      headers: commonHeaders,
      body: JSON.stringify({
        message: "Processing successful",
        graph_output: finalState // This contains all intermediate and final results
      }),
    };

  } catch (graphError) {
    console.error('LangGraph execution error:', graphError);
    return {
      statusCode: 500,
      headers: commonHeaders,
      body: JSON.stringify({
        error: 'Graph execution failed',
        message: graphError.message,
        initial_input: initialState // For debugging
      }),
    };
  }
};