// netlify/functions/headline_analyzer/headline_analyzer.js
// This is now the Netlify Handler function.

// For local testing WITH this file, you might still use dotenv.
// For deployed Netlify, environment variables are set in the Netlify UI.
// require('dotenv').config({ path: '../../.env' }); // If .env is in project root, 2 levels up

const { app, nodeDefinitionsForClient } = require('./src/graph_builder');

// Helper to construct graphStructure for the client (same as in previous Netlify handler)
function getGraphStructureForClient(nodesFromBuilder) {
    const graphNodes = [];
    const stateToDetailsKeyMap = {};

    // Pseudo-node for input display
    graphNodes.push({
        id: "input_display",
        displayName: "Input Headline",
        type: "input",
        detailsKey: "input_headline",
        statusKey: "input_headline"
    });
    stateToDetailsKeyMap["input_headline"] = "input_headline";

    nodesFromBuilder.forEach(node => {
        if (node.type === "parallel_llm_group_coordinator" && node.subTasks) {
            graphNodes.push({
                id: `${node.id}_group_display`,
                displayName: node.displayName,
                type: "parallel-group",
                subNodes: node.subTasks.map(subTask => {
                    stateToDetailsKeyMap[subTask.stateOutputKey] = subTask.stateOutputKey;
                    // Add details keys for each sub-task's reverter if they exist
                    // This part requires knowing the convention, e.g. `${subTask.id}_reverter_details`
                    // For now, we just map the main output key. UI can decide how to fetch details.
                    return {
                        id: subTask.id,
                        displayName: subTask.displayName,
                        detailsKey: subTask.stateOutputKey,
                        statusKey: subTask.stateOutputKey
                    };
                })
            });
        } else {
            const detailsKey = node.stateOutputKey || node.id;
            stateToDetailsKeyMap[detailsKey] = detailsKey;
            // Also map details keys for reverter nodes, e.g. for 'speculative_reverter', map 'speculative_reverter_details'
            if (node.id.endsWith('_reverter')) {
                 stateToDetailsKeyMap[`${node.id}_details`] = `${node.id}_details`;
            }


            let clientNodeType = "sequential_processing"; // Default
             if (node.id === "properNoun_replacer1") clientNodeType = "initial_processing";
             else if (node.type === "local_function" && node.functionName && node.functionName.toLowerCase().includes('revert')) clientNodeType = "reversion_step";
             else if (node.type === "local_function" && node.functionName && node.functionName.toLowerCase().includes('save')) clientNodeType = "final_step";
             else if (node.type === "llm_agent") clientNodeType = "llm_processing";


            graphNodes.push({
                id: node.id,
                displayName: node.displayName,
                type: clientNodeType,
                detailsKey: detailsKey,
                statusKey: detailsKey
            });
        }
    });
    return { nodes: graphNodes, stateToDetailsKeyMap };
}


exports.handler = async function(event, context) { // Added context for completeness
    const commonHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key', // Common headers
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
        console.error("Invalid request body:", error);
        return { statusCode: 400, headers: commonHeaders, body: JSON.stringify({ error: 'Invalid request: ' + error.message }) };
    }

    const { nodes: clientGraphNodes, stateToDetailsKeyMap } = getGraphStructureForClient(nodeDefinitionsForClient);
    const graphStructureForClient = { nodes: clientGraphNodes };

    const initialState = {
        input_headline: headline,
        error_messages: []
    };

    try {
        console.log(`[HANDLER] Invoking LangGraph app for headline: "${headline}"`);
        const finalState = await app.invoke(initialState, { recursionLimit: 25 });
        console.log("[HANDLER] LangGraph app finished.");

        const responsePayload = {
            // Always include these for the client
            input_headline: finalState.input_headline,
            flipped_headline: finalState.flipped_headline, // Main synthesized and reverted
            db_save_status: finalState.db_save_status,
            // Add all other keys client expects based on stateToDetailsKeyMap
        };

        for (const [clientKey, stateKey] of Object.entries(stateToDetailsKeyMap)) {
            // Ensure we don't overwrite already set primary keys if mapping is redundant
            if (!responsePayload.hasOwnProperty(clientKey)) {
                responsePayload[clientKey] = finalState[stateKey];
            }
        }
        
        // Explicitly ensure all reverted headlines and their details are in payload if they exist in finalState
        const revertedHeadlines = [
            'speculative_reframing_reverted_headline', 'episodic_thematic_reverted_headline', 'violence_type_reverted_headline','cognitive_frames_reverted_headline', 'euphemism_reverted_headline',
            // Add more state keys for reverted headlines if you have them
        ];
        const reverterDetails = [
            'properNoun_replacement2_details', // for main reverter
            'speculative_reverter_details', 'episodic_thematic_reverter_details', 'violence_type_reverter_details', 'cognitive_frames_reverter_details','euphemism_reverter_details',
             // Add more state keys for reverter details
        ];

        revertedHeadlines.forEach(key => {
            if (finalState[key] !== undefined) responsePayload[key] = finalState[key];
        });
        reverterDetails.forEach(key => {
            if (finalState[key] !== undefined) responsePayload[key] = finalState[key];
        });


        // Also include raw analysis results if the client needs them (as per original code)
        responsePayload.raw_analysis1 = finalState.cognitive_frames_analysis_result;
        responsePayload.raw_analysis2 = finalState.speculative_reframing_result;
        responsePayload.raw_analysis3 = finalState.euphemism_analysis_result;
        responsePayload.raw_analysis4 = finalState.episodic_thematic_analysis_result;
        responsePayload.raw_analysis5 = finalState.violence_type_analysis_result;

        let overallStatusMessage = "Processing successful";
        if (finalState.error_messages && finalState.error_messages.length > 0) {
            overallStatusMessage = `Processing completed with ${finalState.error_messages.length} error(s). First: ${finalState.error_messages[0].substring(0,100)}`;
        }
        if (finalState.db_save_status && !finalState.db_save_status.success) {
            overallStatusMessage += " Warning: Failed to save results to database.";
        }


        return {
            statusCode: 200,
            headers: commonHeaders,
            body: JSON.stringify({
                message: overallStatusMessage,
                data: responsePayload,
                graphStructure: graphStructureForClient,
                errors: finalState.error_messages // Optionally include all errors
            }),
        };

    } catch (graphError) {
        console.error('[HANDLER] LangGraph execution error:', graphError);
        return {
            statusCode: 500,
            headers: commonHeaders,
            body: JSON.stringify({
                error: 'Graph execution failed unexpectedly.',
                details: graphError.message,
                input_headline: headline, // For context
                graphStructure: graphStructureForClient
            }),
        };
    }
};