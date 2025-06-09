// src/node_functions.js
const { callModel, buildMessagesFromPromptConfig } = require('./llm_utils');
const { saveHeadlineData } = require('./aws_utils');
const { resolvePath } = require('./utils/objectPathUtils'); // Make sure this path is correct

// ... (interpolateTemplate can be removed if renderTemplate from llm_utils is used consistently)
// ... (resolvePath can be imported from a utils file)

// --- Generic LLM Node Function ---
async function executeLlmAgentNode(state, nodeConfig) {
    console.log(`--- Running LLM Agent Node: ${nodeConfig.displayName} (ID: ${nodeConfig.id}) ---`);
    const { promptConfig } = nodeConfig;

    if (!promptConfig) {
        const errorMsg = `Configuration error: Prompt config missing for LLM node ${nodeConfig.id}.`;
        console.error(errorMsg);
        return { [nodeConfig.stateOutputKey || `${nodeConfig.id}_error`]: { error: errorMsg } };
    }

    // Prepare data for template interpolation (passed to buildMessagesFromPromptConfig -> renderTemplate)
    const templateArgs = { ...state }; // Start with full state
    if (nodeConfig.stateInputArgs) {
        for (const [argName, stateKey] of Object.entries(nodeConfig.stateInputArgs)) {
            templateArgs[argName] = resolvePath(state, stateKey); // Use resolvePath for safety
        }
    }
     // Special case for synthesizer or any node needing 'headlineToAnalyze'
    if (nodeConfig.stateInputArgs && nodeConfig.stateInputArgs.headlineToSynthesize === 'headlineToAnalyze') {
        templateArgs.headlineToSynthesize = state.headlineToAnalyze || state.input_headline || "";
    }


    // 1. Build messages using promptConfig and current state/args
    const messages = buildMessagesFromPromptConfig(promptConfig, state, templateArgs);
    // console.log(`[NODE_FUNCTIONS] Built messages for ${nodeConfig.id}:`, JSON.stringify(messages, null, 2));


    // 2. Call the model with these messages
    // Extract model name and generation args from promptConfig if they exist
    const modelName = promptConfig.model || 'gemini-1.5-flash-latest';
    const generationArgs = {
        temperature: promptConfig.temperature || 0.3,
        maxOutputTokens: promptConfig.maxOutputTokens || 2048
    };
    const llmResult = await callModel(messages, modelName, generationArgs);

    const update = {};
    if (nodeConfig.stateOutputKey) {
        update[nodeConfig.stateOutputKey] = llmResult;
    } else {
        console.warn(`LLM Node ${nodeConfig.id}: No stateOutputKey defined. LLM result might not be stored correctly.`);
        // Avoid directly merging an error object into state without a key
        if (llmResult && !llmResult.error) Object.assign(update, llmResult);
        else update[`${nodeConfig.id}_error`] = llmResult || { error: "LLM call failed or returned no result." };
    }

    if (llmResult && !llmResult.error) {
        if (nodeConfig.derivedStateOutputs) {
            for (const [derivedKey, V_config] of Object.entries(nodeConfig.derivedStateOutputs)) {
                let value = resolvePath(llmResult, V_config.path); // Use resolvePath from llm_utils
                if (value !== undefined) {
                    update[derivedKey] = value;
                } else if (V_config.fallbackKey && state[V_config.fallbackKey] !== undefined) {
                    update[derivedKey] = state[V_config.fallbackKey];
                } else if (V_config.fallbackValue !== undefined) {
                    update[derivedKey] = V_config.fallbackValue;
                } else {
                    update[derivedKey] = undefined;
                }
            }
        }
    } else {
        console.warn(`LLM Node ${nodeConfig.id} failed or returned error: ${llmResult?.error}`);
        // Error already stored in stateOutputKey. Apply fallbacks for derived outputs.
        if (nodeConfig.derivedStateOutputs) {
            for (const [derivedKey, V_config] of Object.entries(nodeConfig.derivedStateOutputs)) {
                // Apply fallbacks as before
                if (V_config.fallbackKey && state[V_config.fallbackKey] !== undefined) {
                    update[derivedKey] = state[V_config.fallbackKey];
                } else if (V_config.fallbackValue !== undefined) {
                    update[derivedKey] = V_config.fallbackValue;
                } else {
                    update[derivedKey] = undefined;
                }
            }
        }
    }
    return update;
}

// --- Custom JavaScript Node Functions ---
// revertMainSynthesizedHeadline, revertGenericAnalyzerHeadline, saveAllToDynamoDBNode
// These should largely remain the same as in the previous version, but ensure they use
// resolvePath if accessing nested state properties via stateInputArgs.

async function revertMainSynthesizedHeadline(state, nodeConfig) {
    console.log(`--- Running Node: ${nodeConfig.displayName} (ID: ${nodeConfig.id}) ---`);
    const textToProcessKey = nodeConfig.stateInputArgs.text_with_placeholders;
    const properNounMapKey = nodeConfig.stateInputArgs.properNoun_map;

    const textToProcess = resolvePath(state, textToProcessKey); // Use resolvePath for safety
    const properNounMap = resolvePath(state, properNounMapKey, {}); // Default to empty object
    const update = {};

    const finalHeadlineOutputKey = "flipped_headline";
    const detailsOutputKey = "properNoun_replacement2_details";

    update[detailsOutputKey] = { /* ... initial details ... */ };
    update[finalHeadlineOutputKey] = textToProcess || `Error: Missing text for ${nodeConfig.displayName}`;

    // ... rest of the logic from previous version ...
    if (!textToProcess || typeof textToProcess !== 'string') {
        // console.warn(`${nodeConfig.id}: No valid text to process from state key '${textToProcessKey}'.`);
        update[detailsOutputKey].status = "Skipped - no input text";
        return update;
    }
    // ... (proper noun map check & replacement logic)
    let processedText = textToProcess;
    const replacementsMade = {};
    if (Object.keys(properNounMap).length > 0) {
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
    } else {
        // console.log(`${nodeConfig.id}: No properNoun map. Text remains as is.`);
    }
    
    update[finalHeadlineOutputKey] = processedText;
    update[detailsOutputKey] = {
        status: Object.keys(properNounMap).length > 0 ? "Completed" : "Skipped - no properNoun map",
        original_text_with_placeholders: textToProcess,
        final_text: processedText,
        replacements_made: replacementsMade,
        properNoun_map_used: properNounMap
    };
    return update;
}

// src/node_functions.js

async function revertGenericAnalyzerHeadline(state, nodeConfig) {
    console.log(`--- Running Node: ${nodeConfig.displayName} (ID: ${nodeConfig.id}) ---`);
    const update = {};

    const analyzerResultObjectKey = nodeConfig.stateInputArgs.analyzer_result_object;
    const properNounMapKey = nodeConfig.stateInputArgs.properNoun_map;
    
    // --- CHANGE IS HERE ---
    // We've removed the configurable path. The function now correctly and explicitly
    // expects the key to always be 'rewritten_headline'.
    const analyzerHeadlineKey = 'rewritten_headline';

    const analyzerResultObject = resolvePath(state, analyzerResultObjectKey);
    const properNounMap = resolvePath(state, properNounMapKey, {});
    
    const outputStateKey = nodeConfig.stateOutputKey;
    const detailsStateKey = `${nodeConfig.id}_details`;

    update[detailsStateKey] = { /* ... initial details ... */ };
    update[outputStateKey] = `Error: Initial conditions not met for ${nodeConfig.displayName}`;

    if (!analyzerResultObject || typeof analyzerResultObject !== 'object' || analyzerResultObject.error) {
        const errorMessage = `Skipped - Analyzer data missing/errored: ${analyzerResultObject?.error || 'Not found'}`;
        update[detailsStateKey].status = errorMessage;
        // Also update the main output key for clarity in the final result
        update[outputStateKey] = "Not applicable - " + errorMessage;
        return update;
    }

    // Now we use the hardcoded, standardized key.
    const textToProcess = analyzerResultObject[analyzerHeadlineKey];
    update[detailsStateKey].text_found_for_reversion = textToProcess;

    if (!textToProcess || typeof textToProcess !== 'string' || textToProcess.toLowerCase().includes("no alternative") || textToProcess.toLowerCase().includes("no significant")) {
        const reason = !textToProcess ? 'no text at key' : 'analyzer indicated no flip was generated';
        update[detailsStateKey].status = `Skipped - ${reason}`;
        update[outputStateKey] = "Not applicable or no text generated by analyzer";
        update[detailsStateKey].final_reverted_text = textToProcess;
        return update;
    }
    
    let processedText = textToProcess;
    const replacementsMade = {};
    if (Object.keys(properNounMap).length > 0) {
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
    }
    
    update[outputStateKey] = processedText;
    update[detailsStateKey] = {
        status: "Completed",
        original_analyzer_result: analyzerResultObject,
        text_with_placeholders_key: analyzerHeadlineKey,
        text_found_for_reversion: textToProcess,
        final_reverted_text: processedText,
        replacements_made: replacementsMade,
        properNoun_map_used: properNounMap
    };
    return update;
}


async function collectAndVerifyDataForSaver(state, nodeConfig) {
    console.log(`--- Running Node: ${nodeConfig.displayName} (ID: ${nodeConfig.id}) ---`);
    const dataPackage = {};
    let allPrerequisitesMet = true;
    let missingKeys = [];

    console.log(`[${nodeConfig.id}] Available state keys:`, JSON.stringify(Object.keys(state)));

    if (nodeConfig.stateInputArgs) {
        for (const [packageKey, stateKeyOrPath] of Object.entries(nodeConfig.stateInputArgs)) {
            const value = resolvePath(state, stateKeyOrPath);
            if (value === undefined) {
                console.warn(`[${nodeConfig.id}] Prerequisite state key/path '${stateKeyOrPath}' for package key '${packageKey}' is undefined.`);
                // Storing a specific marker for truly missing data
                dataPackage[packageKey] = "__MISSING_PREREQUISITE__"; 
                allPrerequisitesMet = false; // Optional: could decide to not proceed to saver
                missingKeys.push(stateKeyOrPath);
            } else {
                dataPackage[packageKey] = value;
            }
            // console.log(`[${nodeConfig.id}] Packaging: '${packageKey}' =`, dataPackage[packageKey]);
        }
    } else {
        console.error(`[${nodeConfig.id}] Error: No stateInputArgs configured for data collector.`);
        // Return an error structure or an empty package
        return { 
            [nodeConfig.stateOutputKey]: { error: "Collector not configured" },
            error_messages: ["Data collector node not configured with inputs."]
         };
    }

    if (!allPrerequisitesMet) {
        console.warn(`[${nodeConfig.id}] Not all prerequisite data available for saver. Missing: ${missingKeys.join(', ')}. Package:`, dataPackage);
        // Decide: either proceed and let saver handle missing data (as it does now by saving "Data not available"),
        // or you could introduce an error state here to halt before saving.
        // For now, we'll pass the package as is; aws_utils will handle undefined/missing.
    } else {
        console.log(`[${nodeConfig.id}] All prerequisite data collected successfully for saver. Package:`, dataPackage);
    }
    
    return {
        [nodeConfig.stateOutputKey]: dataPackage // This sets state.data_package_for_saver
    };
}

async function saveAllToDynamoDBNode(state, nodeConfig) {
    console.log(`--- Running Node: ${nodeConfig.displayName} (ID: ${nodeConfig.id}) ---`);
    
    // The data to save now comes from a single state key, which is an object (the package)
    const packagedDataKey = nodeConfig.stateInputArgs.packaged_data; // e.g., "data_package_for_saver"
    const dataToPassToAwsUtils = resolvePath(state, packagedDataKey);

    console.log(`[${nodeConfig.id}] Received packaged data from state key '${packagedDataKey}':`, JSON.stringify(dataToPassToAwsUtils, null, 2));

    if (!dataToPassToAwsUtils || typeof dataToPassToAwsUtils !== 'object') {
        console.error(`[${nodeConfig.id}] Error: Packaged data for saver not found or not an object in state.'${packagedDataKey}'.`);
        return { [nodeConfig.stateOutputKey || 'db_save_status']: { success: false, message: "Internal error: Data package for saver missing." } };
    }

    // The keys within dataToPassToAwsUtils should now directly correspond to what aws_utils.js expects
    // e.g., dataToPassToAwsUtils.input_headline, dataToPassToAwsUtils.main_flipped_headline_from_state etc.
    // which were set by the data_collector_for_saver node.

    if (!dataToPassToAwsUtils.input_headline_for_saver && !dataToPassToAwsUtils.input_headline) { // Check both potential keys
        console.error(`[${nodeConfig.id}] Error: 'input_headline' is missing from the packaged data for DynamoDB.`);
        return { [nodeConfig.stateOutputKey || 'db_save_status']: { success: false, message: "Critical error: input_headline not found in data package for DB save." } };
    }
    
    // Rename key if necessary before passing to aws_utils
    const finalDataForAws = {...dataToPassToAwsUtils};
    if (finalDataForAws.input_headline_for_saver) {
        finalDataForAws.input_headline = finalDataForAws.input_headline_for_saver;
        delete finalDataForAws.input_headline_for_saver;
    }


    const status = await saveHeadlineData(finalDataForAws); // saveHeadlineData is from aws_utils.js
    console.log(`[${nodeConfig.id}] Result from saveHeadlineData:`, JSON.stringify(status, null, 2));
    
    return { [nodeConfig.stateOutputKey || 'db_save_status']: status };
}

const customNodeFunctions = {
    revertProperNouns: revertMainSynthesizedHeadline,
    revertGenericAnalyzerHeadline: revertGenericAnalyzerHeadline,
    collectAndVerifyDataForSaver: collectAndVerifyDataForSaver, // Add new function
    saveAllToDynamoDB: saveAllToDynamoDBNode,
};

module.exports = {
    executeLlmAgentNode,
    customNodeFunctions
};