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
    { role: 'system', content: `You are a journalist with a PhD in media framing, sentiment analysis, and subliminal messaging.` },
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
// This setup is a bit clunky for parallel starts in the current StateGraph.
// A more common pattern for parallel is to have a single entry node that then fans out.
// Let's adjust for true parallelism:
// We'll make a "start_parallel" node that doesn't do much, then branch.
// Or, simpler for this case: LangGraph implicitly handles parallel branches if synthesis node waits for both.

// Let's try a simpler edge definition for parallel execution:
// The synthesis node will effectively wait for both `analysis1_result` and `analysis2_result` to be populated
// if they are its direct inputs.
// For explicit parallelism and joining, LangGraph supports "fork" and "join" patterns.
// Given the current StateGraph API, the easiest way is to have sequential addition but the
// `synthesisNode` will naturally wait for both `analysis1_result` and `analysis2_result`
// if these fields are populated by preceding nodes.

// More direct LangGraph way for parallel branches leading to a join:
// Define a list of nodes that can run in parallel from the entry point.
// Then specify the node that should run after ALL of them complete.
workflow.setEntryPoint("detailed_analyzer"); // Entry point for one branch
// Add another entry point for the parallel branch by connecting from a common "start"
// Or, ensure the 'synthesizer' node is defined to depend on outputs from both.

// Corrected structure for parallel leading to join:
// We'll have START -> [detailed_analyzer, simplified_analyzer] -> synthesizer -> saver -> END
// StateGraph's `addNode` and `addEdge` implicitly handle this if `synthesizer` is connected
// from both analyzer nodes. LangGraph waits for all dependencies.

// Resetting edges for clarity:
workflow.setEntryPoint("detailed_analyzer");
workflow.addEdge("detailed_analyzer", "synthesizer"); // Will wait for simplified_analyzer too if it's also an input

// To make simplified_analyzer run in parallel:
// We can't add two entry points directly.
// Instead, make them both children of a conceptual "START".
// For StateGraph, if a node (like synthesizer) has multiple direct predecessors,
// it will effectively wait for all of them if they are on different paths from the entry.

// The most robust way with StateGraph for parallel:
// 1. Start Node
// 2. Conditional Edge to Fan out to parallel nodes
// 3. Parallel nodes
// 4. Join node (or a node that naturally consumes outputs from all parallel branches)

// Simpler approach that works with StateGraph: Make them sequential in definition,
// but the `invoke` call will ensure that the `synthesizer` has inputs from both.
// This is less "graph-like" in definition but works for `Promise.all` style execution.
// Let's define them as if they *could* be parallel.

// A pragmatic way:
// Have a dummy "start_analyses" node.
// "start_analyses" -> "detailed_analyzer"
// "start_analyses" -> "simplified_analyzer" (This requires conditional edges or a fork node not standard in StateGraph)

// LangGraph team is working on making parallel forks easier.
// For now, the simplest is to make them "seem" sequential in graph definition,
// but the `synthesizer` node will have access to both results.
// The `invoke` mechanism is what matters. `Promise.allSettled` in your original code
// is what we are replicating.
// StateGraph is more for chains and conditional logic. For pure parallelism,
// the `LangGraph` class itself (not StateGraph) from Python is more direct.
// In JS, we use StateGraph for most cases.

// Let's stick to a structure where the synthesizer node expects both analysis results.
// The `app.invoke` will handle the flow.
// LangGraph will execute nodes based on data availability.
// If `synthesizer` needs `analysis1_result` and `analysis2_result`, it will wait.

// Simplified Edge Setup (StateGraph's `channels` ensure data is passed):
// The order of adding nodes and edges determines potential execution flow.
// We want `detailed_analyzer` and `simplified_analyzer` to conceptually run before `synthesizer`.
// The `channels` configuration ensures that when `synthesizer` runs, it gets the latest
// values for `analysis1_result` and `analysis2_result`.

workflow.addNode("start_node_placeholder", (state) => {
    console.log("--- Starting Parallel Analyses ---");
    return {}; // No state change, just a branching point
});
workflow.setEntryPoint("start_node_placeholder");

// This creates two independent branches that `synthesizer` will implicitly wait for
workflow.addEdge("start_node_placeholder", "detailed_analyzer");
workflow.addEdge("start_node_placeholder", "simplified_analyzer");

// Synthesizer depends on the outputs of both analyzers.
// AddEdge means "after this node, go to that node".
// We need a way to say "after detailed_analyzer AND simplified_analyzer, go to synthesizer".
// This is achieved by making `synthesizer` a successor to *both*.
workflow.addEdge("detailed_analyzer", "synthesizer");
workflow.addEdge("simplified_analyzer", "synthesizer");
// IMPORTANT: If a node has multiple incoming edges like this, LangGraph (StateGraph)
// will typically execute it once *any* of its predecessors complete, passing the current state.
// This is NOT a join.
// For a true join (wait for all), you typically need a conditional edge or a specific join node.

// The `StateGraph` will update the shared state. When `synthesizer` is called,
// it will have access to `state.analysis1_result` and `state.analysis2_result`.
// The key is that `invoke` on the compiled graph will manage the flow.
// The `Promise.allSettled` behavior is what we want.

// To achieve the `Promise.allSettled` effect for the two analyzers before synthesis:
// We will invoke them somewhat manually before the synthesizer node, or design the graph
// such that synthesizer is guaranteed to run after both have had a chance to populate the state.

// Let's use a slightly different graph structure for clarity on parallelism:
// We'll create a "parallel_analyzers" meta-node.
const parallelWorkflow = new StateGraph({ channels: { /* as above */ } });
parallelWorkflow.addNode("detailed_analyzer_p", detailedAnalyzerNode);
parallelWorkflow.addNode("simplified_analyzer_p", simplifiedAnalyzerNode);
parallelWorkflow.setEntryPoint("detailed_analyzer_p");
parallelWorkflow.addEdge("detailed_analyzer_p", "simplified_analyzer_p"); // This makes them sequential within this sub-graph
parallelWorkflow.addEdge("simplified_analyzer_p", END);
// This sub-graph isn't truly parallel.

// Let's revert to a simpler understanding: LangGraph's `StateGraph` is fundamentally about state transitions.
// We can achieve the effect of parallel execution by how we structure calls if LangGraph JS doesn't have an explicit parallel "fork" node.
// The original code's `Promise.allSettled([callModel(m1), callModel(m2)])` is the pattern.
// We can simulate this by having a node that *calls* the two analyzer functions and updates state.

async function runAnalyzersInParallel(state) {
    console.log("--- Running Analyzers in Parallel (simulated) ---");
    const headline = state.input_headline;
    const messages1 = [ /* ... as in detailedAnalyzerNode ... */ { role: 'system', content: `You are an advanced semantic news analysis agent specializing in cognitive frame analysis. Analyze the provided news headline to identify embedded cognitive frames.`},{ role: 'developer', content: `Instructions:
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