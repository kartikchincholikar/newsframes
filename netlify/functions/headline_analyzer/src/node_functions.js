const { callModel } = require('./llm_utils');
const { saveHeadlineData } = require('./aws_utils');

// Generic LLM Node
async function llmNode(state, graphConfig, nodeConfig) {
    console.log(`--- Running LLM Node: ${nodeConfig.id} ---`);
    const promptDefinition = graphConfig.prompts[nodeConfig.promptId];
    if (!promptDefinition) {
        console.error(`Prompt definition not found for ID: ${nodeConfig.promptId}`);
        return { error_message: `Configuration error: Prompt ${nodeConfig.promptId} not found.` };
    }

    const result = await callModel(promptDefinition, state, graphConfig);
    const update = {};

    if (result && !result.error) {
        // Map LLM output to state keys based on promptDefinition.output_mapping
        for (const stateKey in promptDefinition.output_mapping) {
            const sourceKey = promptDefinition.output_mapping[stateKey];
            if (sourceKey === ".") { // Map the whole result object
                update[stateKey] = result;
            } else if (result.hasOwnProperty(sourceKey)) {
                update[stateKey] = result[sourceKey];
            } else {
                console.warn(`LLM Node ${nodeConfig.id}: Expected key "${sourceKey}" not found in LLM response for state key "${stateKey}".`);
                // Optionally set a default or error indicator
            }
        }
    } else {
        console.warn(`LLM Node ${nodeConfig.id} (Prompt: ${nodeConfig.promptId}) failed or returned invalid data.`, result?.error);
        update[promptDefinition.output_mapping?.error_key || `${nodeConfig.id}_error`] = result || { error: `${nodeConfig.id}: Invalid output or call failure`, rawContent: JSON.stringify(result) };
        // Apply fallback values if defined in nodeConfig
        if (nodeConfig.fallbackValue) {
            for (const key in nodeConfig.fallbackValue) {
                // Simple templating for fallback values
                let value = nodeConfig.fallbackValue[key];
                if (typeof value === 'string') {
                    value = value.replace(/{{(.*?)}}/g, (match, stateKey) => state[stateKey.trim()] || '');
                }
                update[key] = value;
            }
        }
    }
    // console.log(`LLM Node ${nodeConfig.id} update:`, update);
    return update;
}

// Specific custom JS nodes (can be generalized further if many share patterns)
async function properNounReplacer2Node(state, graphConfig, nodeConfig) {
    console.log("--- Running properNoun Replacer 2 Node ---");
    let textToProcess = state.flipped_headline_with_placeholders;
    const properNounMap = state.properNoun_map || {};
    const replacementsMade = {};

    if (!textToProcess || typeof textToProcess !== 'string') {
        console.warn("properNoun Replacer 2: No valid text to process from synthesis.");
        return {
            flipped_headline: state.flipped_headline_with_placeholders || "Error: Missing text for properNoun reversion",
            properNoun_replacement2_details: {
                status: "Skipped - no input text",
                original_text_with_placeholders: textToProcess,
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
                original_text_with_placeholders: textToProcess,
                final_text: textToProcess,
                replacements_made: {}
            }
        };
    }

    let processedText = textToProcess;
    for (const placeholder in properNounMap) {
        if (properNounMap.hasOwnProperty(placeholder)) {
            const originalProperNoun = properNounMap[placeholder];
            const escapedPlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escapedPlaceholder, 'g');
            if (processedText.includes(placeholder)) {
                processedText = processedText.replace(regex, originalProperNoun);
                replacementsMade[placeholder] = originalProperNoun;
            }
        }
    }
    console.log("properNoun Replacer 2: Replacements made:", replacementsMade);
    return {
        flipped_headline: processedText,
        properNoun_replacement2_details: {
            status: "Completed",
            original_text_with_placeholders: textToProcess,
            final_text: processedText,
            replacements_made: replacementsMade,
            properNoun_map_used: properNounMap
        }
    };
}

async function saveToDynamoDBNode(state, graphConfig, nodeConfig) {
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

// Node for running multiple analyzers in parallel
// This is a conceptual node; LangGraph handles parallelism if branches are defined from a single node.
// However, for grouping results, we might want an explicit parallel invoker.
// For now, graph_builder.js will handle setting up parallel branches.
// This function might be used if we had a specific aggregation step *after* parallel execution
// but before the next main step. The current LangGraph setup does this implicitly.
// The `parallel_analyzers` node in graph_config.json will be handled by graph_builder.js.

const customNodeFunctions = {
    properNounReplacer2: properNounReplacer2Node,
    saveToDynamoDBNode: saveToDynamoDBNode,
};

module.exports = {
    llmNode,
    customNodeFunctions
};