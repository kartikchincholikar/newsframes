const { compileGraph } = require('./src/graph_builder');
const graphConfig = require('./graph_config.json'); // Load the configuration

// Compile the graph once when the function initializes
let app;
try {
    app = compileGraph(graphConfig);
} catch (error) {
    console.error("Failed to compile graph on initialization:", error);
    // app will remain undefined, and the handler will return an error
}

exports.handler = async function(event) {
    const commonHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', // Adjust for production
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: commonHeaders, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: commonHeaders, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    if (!app) {
        return {
            statusCode: 500,
            headers: commonHeaders,
            body: JSON.stringify({ error: 'Graph compilation failed. Check server logs.' }),
        };
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

    const initialState = { input_headline: headline };
    const graphApiStructure = graphConfig.graphApiStructure; // Use structure from config

    try {
        console.log("Invoking LangGraph app with state:", initialState);
        const finalState = await app.invoke(initialState, { recursionLimit: 15 }); // Increased recursion limit
        console.log("LangGraph app finished. Final state snippet:", {
            flipped_headline: finalState.flipped_headline,
            db_save_status: finalState.db_save_status
        });

        // Construct responsePayload dynamically based on AppState keys
        const responsePayload = {};
        for (const key in graphConfig.appStateChannels) {
            if (finalState.hasOwnProperty(key)) {
                responsePayload[key] = finalState[key];
            }
        }
         // Ensure critical outputs are present, even if undefined
        responsePayload.flipped_headline = finalState.flipped_headline || "Flipped headline not generated";


        // Simplified overall status, detailed status per node is in payload
        let overallStatusMessage = "Processing successful";
        let httpStatusCode = 200;

        if (finalState.error_message) { // A global error propagated
            overallStatusMessage = `Processing error: ${finalState.error_message}`;
            httpStatusCode = 500;
        } else if (finalState.db_save_status && !finalState.db_save_status.success) {
            overallStatusMessage = "Processing completed, but failed to save results to database.";
            // Potentially still 200 if the core task succeeded. Or 500 if save is critical.
        } else if (!finalState.flipped_headline || finalState.flipped_headline.startsWith("Alternative perspective unavailable")) {
            overallStatusMessage = "Processing completed, but flipped headline could not be generated.";
        }


        return {
            statusCode: httpStatusCode,
            headers: commonHeaders,
            body: JSON.stringify({
                message: overallStatusMessage,
                data: responsePayload,
                graphStructure: graphApiStructure // Send the predefined structure
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
                graphStructure: graphApiStructure
            }),
        };
    }
};