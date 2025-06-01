// run_local_analyzer.js (in project root)

// Load environment variables from .env file in the project root
require('dotenv').config();

// Path to the compiled app, relative from project root
const { app, nodeDefinitionsForClient } = require('./netlify/functions/headline_analyzer/src/graph_builder');
const readline = require('readline');

function prettyPrint(obj) {
    return JSON.stringify(obj, null, 2);
}

// ... (The rest of the runAnalysis function and CLI logic from the 
//      previous headline_analyzer.js that was designed as a local runner) ...
// You can copy the 'runAnalysis' function and the readline CLI part directly
// from my previous response for 'headline_analyzer.js' (the one that was a runner).
// Just ensure the require path for graph_builder is correct as above.

async function runAnalysis(headline) {
    if (!headline || headline.trim() === '') {
        console.log("Please provide a headline.");
        return;
    }

    console.log("\n===================================");
    console.log(" Starting Headline Analysis for:");
    console.log(` "${headline}"`);
    console.log("===================================\n");

    const initialState = {
        input_headline: headline,
        error_messages: []
    };

    try {
        const finalState = await app.invoke(initialState, { recursionLimit: 25 });

        console.log("\n===================================");
        console.log(" Analysis Complete. Final State:");
        console.log("===================================\n");

        console.log("Input Headline:", finalState.input_headline);
        console.log("-----------------------------------");
        
        console.log("Main Flipped Headline (Synthesized):", finalState.flipped_headline || "N/A");
        console.log("-----------------------------------");

        if (finalState.speculative_reverted_headline) {
            console.log("Speculative Reverted Headline:", finalState.speculative_reverted_headline);
        }
        if (finalState.episodic_thematic_reverted_headline) {
            console.log("episodic_thematic Reverted Suggestion:", finalState.episodic_thematic_reverted_headline);
        }
        if (finalState.violence_type_reverted_headline) {
            console.log("Violence Type Reverted Headline:", finalState.violence_type_reverted_headline);
        }
        console.log("-----------------------------------");

        if (finalState.db_save_status) {
            console.log("Database Save Status:", finalState.db_save_status.success ? "Success" : "Failed", finalState.db_save_status.message || "");
             if (finalState.db_save_status.headline_id) {
                console.log("  DB Headline ID:", finalState.db_save_status.headline_id);
            }
        } else {
            console.log("Database Save Status: Not available.");
        }
        console.log("-----------------------------------");

        if (finalState.error_messages && finalState.error_messages.length > 0) {
            console.warn("\nEncountered Errors During Processing:");
            finalState.error_messages.forEach((err, index) => console.warn(`  ${index + 1}: ${err}`));
        } else {
            console.log("\nNo errors reported during processing.");
        }
        
        console.log("\n===================================");

    } catch (error) {
        console.error("\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
        console.error(" Critical Error Running Graph:");
        console.error(error.message);
        console.error(error.stack);
        console.error("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n");
    }
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askForHeadline() {
    rl.question("\nEnter a headline to analyze (or type 'exit' to quit): ", async (headline) => {
        if (headline.toLowerCase() === 'exit') {
            rl.close();
            process.exit(0);
        }
        await runAnalysis(headline);
        askForHeadline();
    });
}

if (process.argv.length > 2) {
    const headlineFromArg = process.argv.slice(2).join(" ");
    runAnalysis(headlineFromArg).then(() => askForHeadline());
} else {
    askForHeadline();
}