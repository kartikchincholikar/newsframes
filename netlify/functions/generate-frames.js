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

// --- Utility Functions ---
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
      temperature: 0.3, // Slightly lower for more deterministic properNoun replacement
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

// --- LangGraph State Definition ---
/**
 * @typedef {object} AppState
 * @property {string} [input_headline]
 * @property {string} [headline_with_placeholders] The headline after properNoun_replacer1
 * @property {object} [properNoun_map] Mapping of placeholders to original properNouns
 * @property {object | {error: string, rawContent?: string}} [properNoun_replacement1_result] Result of properNoun_replacer1
 * @property {object | {error: string, rawContent?: string}} [analysis1_result]
 * @property {object | {error: string, rawContent?: string}} [analysis2_result]
 * @property {object | {error: string, rawContent?: string}} [synthesis_result]
 * @property {string} [flipped_headline_with_placeholders] Flipped headline from synthesizer (may contain placeholders)
 * @property {string} [flipped_headline] Final flipped headline after properNoun_replacer2
 * @property {object} [properNoun_replacement2_details] Details of properNoun_replacer2 (e.g., which replacements occurred)
 * @property {{success: boolean, message?: string}} [db_save_status]
 * @property {string} [error_message]
 */

// --- LangGraph Nodes ---

async function properNounReplacer1Node(state) {
    console.log("--- Running properNoun Replacer 1 Node ---");
    const headline = state.input_headline;

    const messages = [
        { role: 'system', content: "You are an AI assistant. Your task is to replace proper nouns in the given text with unique, bracketed, uppercase placeholders (e.g., [PERSON_A], [THING_B], [LOCATION_C]). Identify the original proper nouns and the placeholders you created. Output ONLY valid JSON." },
        { role: 'developer', content: `Instructions:
1. Analyze the input text: "${headline}".
2. Identify all proper nouns.
3. For each identified proper noun, create a unique placeholder (e.g., [PERSON_A], [PERSON_B], [OBJECT_A], [GROUP_A]).
4. Replace the proper nouns in the text with these placeholders.
5. Provide a mapping of each placeholder to its original proper noun.
6. Your entire output MUST be a single, valid JSON object.

Required JSON Output Schema:
\`\`\`json
{
  "original_text": "The original input text",
  "text_with_placeholders": "The text with properNouns replaced by placeholders",
  "properNoun_map": {
    "[PLACEHOLDER_A]": "original_properNoun_A",
    "[PLACEHOLDER_B]": "original_properNoun_B"
  }
}
\`\`\`` },
        { role: 'user', content: `Process this text: "${headline}"` }
    ];

    const result = await callModel(messages);

    if (result && !result.error && result.text_with_placeholders && result.properNoun_map) {
        return {
            properNoun_replacement1_result: result,
            headline_with_placeholders: result.text_with_placeholders,
            properNoun_map: result.properNoun_map
        };
    } else {
        console.warn("properNoun Replacer 1 failed or returned invalid data. Using original headline for downstream tasks.", result?.error);
        return {
            properNoun_replacement1_result: result || { error: "properNoun Replacer 1: Invalid output", rawContent: JSON.stringify(result) },
            headline_with_placeholders: headline, // Fallback to original
            properNoun_map: {} // Empty map
        };
    }
}

async function runAnalyzersInParallelNode(state) {
    console.log("--- Running Analyzers in Parallel Node ---");
    // Use the headline with placeholders if available, otherwise original input
    const headlineToAnalyze = state.headline_with_placeholders || state.input_headline;

    const messages1 = [
      { role: 'system', content: "You are an AI assistant. Analyze the headline (which may contain placeholders like [PERSON_A]) for cognitive frames. Output ONLY valid JSON." },
      { role: 'developer', content: `Instructions: Analyze the provided headline to identify embedded cognitive frames. Required JSON Output Schema: \`\`\`json { "input_text": "...", "frames": [{ "frame_type": "...", "keywords": [], "linguistic_indicators": "...", "agent_patient_analysis": {"agent": "...", "patient": "..."}, "contextual_elements": "...", "summary": "..."}] } \`\`\`` },
      { role: 'user', content: `Analyze this headline: "${headlineToAnalyze}"` }
    ];
    const messages2 = [
      { role: 'system', content: "You are an AI assistant. Decompose the headline (which may contain placeholders like [PERSON_A]) into semantic frames. Output ONLY valid JSON." },
      { role: 'developer', content: `Instructions: Analyze the headline for semantic frames. Required JSON Output Schema: \`\`\`json { "input_headline": "...", "frames": [{"frame_type": "...", "keywords": [], "agent": "...", "action": "...", "patient": "...", "contextual_cues": []}] } \`\`\`` },
      { role: 'user', content: `Analyze this headline: "${headlineToAnalyze}"` }
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
  const headlineToSynthesize = state.headline_with_placeholders || state.input_headline;
  const { analysis1_result, analysis2_result } = state;
  const agent1Failed = !!(analysis1_result && analysis1_result.error);
  const agent2Failed = !!(analysis2_result && analysis2_result.error);

  if (agent1Failed && agent2Failed) {
    console.warn("Both analysis agents failed. Synthesis may be limited.");
  }

  const messages3 = [
    { role: 'system', content: "You are an AI assistant. Synthesize analyses, compare them, and generate a flipped headline (which may contain placeholders like [PERSON_A]). Output ONLY valid JSON." },
    { role: 'developer', content: `Instructions: Compare analyses, highlight similarities/differences, output a "flipped_headline". Required JSON Output Schema: \`\`\`json { "headline": "${headlineToSynthesize}", "flipped_headline": "...", "key_similarities": [], "key_differences": [], "agent1_had_error": ${agent1Failed}, "agent2_had_error": ${agent2Failed} } \`\`\`` },
    { role: 'user', content: `Original Headline (potentially with placeholders): "${headlineToSynthesize}"\nAnalysis1: ${JSON.stringify(analysis1_result)}\nAnalysis2: ${JSON.stringify(analysis2_result)}` }
  ];

  const synthesis_result = await callModel(messages3);
  let flipped_headline_with_placeholders = 'Alternative perspective unavailable (synthesis error or not found)';

  if (synthesis_result && !synthesis_result.error && typeof synthesis_result.flipped_headline === 'string') {
    flipped_headline_with_placeholders = synthesis_result.flipped_headline;
  } else if (synthesis_result && synthesis_result.error) {
    flipped_headline_with_placeholders = `Alternative perspective unavailable (Error: ${synthesis_result.error})`;
  } else if (typeof synthesis_result === 'object' && synthesis_result !== null && !synthesis_result.flipped_headline) {
     flipped_headline_with_placeholders = 'Alternative perspective unavailable (flipped_headline field missing)';
  } else if (typeof synthesis_result !== 'object' && synthesis_result !== null) {
     flipped_headline_with_placeholders = `Alternative perspective unavailable (Unexpected synthesis output type)`;
  }
  
  // Store the potentially placeholder-filled headline from synthesis
  // The final flipped_headline will be set by properNounReplacer2Node
  return { synthesis_result, flipped_headline_with_placeholders };
}

async function properNounReplacer2Node(state) {
    console.log("--- Running properNoun Replacer 2 Node ---");
    let textToProcess = state.flipped_headline_with_placeholders;
    const properNounMap = state.properNoun_map || {};
    const replacementsMade = {};

    if (!textToProcess || typeof textToProcess !== 'string') {
        console.warn("properNoun Replacer 2: No valid text to process from synthesis.");
        return { 
            flipped_headline: state.flipped_headline_with_placeholders || "Error: Missing text for properNoun reversion", // Fallback
            properNoun_replacement2_details: {
                status: "Skipped - no input text",
                original_text: textToProcess,
                final_text: textToProcess,
                replacements_made: {}
            }
        };
    }
    if (Object.keys(properNounMap).length === 0) {
        console.log("properNoun Replacer 2: No properNoun map provided, returning text as is.");
        return { 
            flipped_headline: textToProcess,
            properNoun_replacement2_details: {
                status: "Skipped - no properNoun map",
                original_text: textToProcess,
                final_text: textToProcess,
                replacements_made: {}
            }
        };
    }

    let processedText = textToProcess;
    // Iterate over the map and replace placeholders
    for (const placeholder in properNounMap) {
        if (properNounMap.hasOwnProperty(placeholder)) {
            const originalproperNoun = properNounMap[placeholder];
            // Use a regex to replace all occurrences of the placeholder
            // Escape special characters in placeholder for regex
            const escapedPlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escapedPlaceholder, 'g');
            
            if (processedText.includes(placeholder)) {
                processedText = processedText.replace(regex, originalproperNoun);
                replacementsMade[placeholder] = originalproperNoun;
            }
        }
    }
    
    console.log("properNoun Replacer 2: Replacements made:", replacementsMade);
    return {
        flipped_headline: processedText, // This is the final, reverted headline
        properNoun_replacement2_details: {
            status: "Completed",
            original_text_with_placeholders: textToProcess,
            final_text: processedText,
            replacements_made: replacementsMade,
            properNoun_map_used: properNounMap
        }
    };
}


async function saveToDynamoDBNode(state) {
  console.log("--- Running Save to DynamoDB Node ---");
  // Use the final flipped_headline which should have properNouns reverted
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

// --- LangGraph Workflow Definition ---
const appStateChannels = {
    input_headline: { value: (x, y) => y, default: () => undefined },
    headline_with_placeholders: { value: (x, y) => y, default: () => undefined },
    properNoun_map: { value: (x, y) => y, default: () => ({}) },
    properNoun_replacement1_result: { value: (x, y) => y, default: () => undefined },
    analysis1_result: { value: (x, y) => y, default: () => undefined },
    analysis2_result: { value: (x, y) => y, default: () => undefined },
    synthesis_result: { value: (x, y) => y, default: () => undefined },
    flipped_headline_with_placeholders: { value: (x, y) => y, default: () => undefined },
    flipped_headline: { value: (x, y) => y, default: () => undefined },
    properNoun_replacement2_details: { value: (x, y) => y, default: () => undefined },
    db_save_status: { value: (x, y) => y, default: () => undefined },
    error_message: { value: (x, y) => y, default: () => undefined },
};

const appGraph = new StateGraph({ channels: appStateChannels });

appGraph.addNode("properNoun_replacer1", properNounReplacer1Node);
appGraph.addNode("parallel_analyzers", runAnalyzersInParallelNode);
appGraph.addNode("synthesizer", synthesisNode);
appGraph.addNode("properNoun_replacer2", properNounReplacer2Node);
appGraph.addNode("saver", saveToDynamoDBNode);

// Define edges
appGraph.setEntryPoint("properNoun_replacer1");
appGraph.addEdge("properNoun_replacer1", "parallel_analyzers");
appGraph.addEdge("parallel_analyzers", "synthesizer");
appGraph.addEdge("synthesizer", "properNoun_replacer2");
appGraph.addEdge("properNoun_replacer2", "saver");
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

  const graphStructure = {
    nodes: [
      {
        id: "input_display",
        displayName: "Input Headline",
        type: "input",
        detailsKey: "input_headline",
        statusKey: "input_headline"
      },
      {
        id: "properNoun_replacer1_display",
        displayName: "0. properNoun Replacer (Initial)",
        type: "sequential",
        detailsKey: "properNoun_replacement1_result", // Stores the full LLM output for this node
        statusKey: "properNoun_replacement1_result"  // Check error on this object
      },
      {
        id: "parallel_analyzers_stage",
        type: "parallel-group",
        subNodes: [
          { id: "analysis1", displayName: "1a. Detailed Analysis", detailsKey: "raw_analysis1", statusKey: "raw_analysis1" },
          { id: "analysis2", displayName: "1b. Simplified Analysis", detailsKey: "raw_analysis2", statusKey: "raw_analysis2" }
        ]
      },
      {
        id: "synthesizer_display", 
        displayName: "2. Synthesizer",
        type: "sequential",
        detailsKey: "synthesis_details",
        statusKey: "synthesis_details"
      },
      {
        id: "properNoun_replacer2_display",
        displayName: "3. properNoun Reverter (Final)",
        type: "sequential",
        detailsKey: "properNoun_replacement2_details", // Stores details of the replacement
        statusKey: "properNoun_replacement2_details"  // Check for presence of this object (or a specific status field within it if added)
      },
      {
        id: "saver_display",
        displayName: "4. Save to DB",
        type: "sequential",
        detailsKey: "db_save_status",
        statusKey: "db_save_status"
      }
    ]
  };

  const initialState = { input_headline: headline };

  try {
    console.log("Invoking LangGraph app with state:", initialState);
    const finalState = await app.invoke(initialState, { recursionLimit: 10 }); // Increased recursion limit for more nodes
    console.log("LangGraph app finished.");

    // Ensure all keys needed by graphStructure are present in responsePayload
    const responsePayload = {
        input_headline: finalState.input_headline,
        properNoun_replacement1_result: finalState.properNoun_replacement1_result, // For properNoun Replacer 1 details
        raw_analysis1: finalState.analysis1_result, 
        raw_analysis2: finalState.analysis2_result,
        synthesis_details: finalState.synthesis_result,
        properNoun_replacement2_details: finalState.properNoun_replacement2_details, // For properNoun Reverter details
        flipped_headline: finalState.flipped_headline, // Final flipped headline
        db_save_status: finalState.db_save_status,
    };
    
    let overallStatusMessage = "Processing successful";
    let httpStatusCode = 200;

    // Check for errors in critical steps
    if (finalState.properNoun_replacement1_result?.error) {
        overallStatusMessage = "Initial properNoun replacement failed.";
    } else if (finalState.analysis1_result?.error && finalState.analysis2_result?.error) {
        overallStatusMessage = "Both analysis steps failed.";
    } else if (finalState.synthesis_result?.error || (finalState.flipped_headline_with_placeholders && finalState.flipped_headline_with_placeholders.startsWith("Alternative perspective unavailable (Error:"))) {
        overallStatusMessage = "Synthesis failed or encountered an error.";
    } else if (finalState.properNoun_replacement2_details?.status && finalState.properNoun_replacement2_details.status.includes("Skipped")) {
         overallStatusMessage = "Final properNoun reversion was skipped or had issues.";
    } else if (finalState.db_save_status && !finalState.db_save_status.success) {
        overallStatusMessage = "Processing completed, but failed to save results to database.";
    }


    return {
      statusCode: httpStatusCode,
      headers: commonHeaders,
      body: JSON.stringify({
        message: overallStatusMessage,
        data: responsePayload,
        graphStructure: graphStructure
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
        graphStructure: graphStructure
      }),
    };
  }
};