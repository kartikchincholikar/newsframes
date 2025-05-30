// src/graph_builder.js
const { StateGraph, END } = require('@langchain/langgraph');
const fs = require('fs');
const path = require('path');
const { appStateChannels } = require('./state_definition'); // Corrected path
const { executeLlmAgentNode, customNodeFunctions } = require('./node_functions'); // Corrected path
const { callModel } = require('./llm_utils'); // For parallel_llm_group_coordinator

// --- Utilities from node_functions.js (or move to a shared utils file) ---
function interpolateTemplate(template, data) {
    if (!template) return "";
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, key) => {
        const keys = key.split('.');
        let value = data;
        for (const k of keys) {
            if (value && typeof value === 'object' && k in value) {
                value = value[k];
            } else {
                return match;
            }
        }
        if (typeof value === 'object' && value !== null) return JSON.stringify(value);
        return value !== undefined ? String(value) : match;
    });
}
// --- End Utilities ---


// Function to load graph definition from graph_config.json in the project root
// src/graph_builder.js
const path = require('path');
const fs = require('fs');

function loadGraphDefinition() {
    const localDevConfigPath = path.resolve(__dirname, '../graph_config.json'); // For local dev: src/../graph_config.json -> headline_analyzer/graph_config.json

    // Paths to try in the deployed Lambda environment:
    // 1. Directly in the execution root (/var/task/graph_config.json)
    //    This is where included_files = ["graph_config.json"] (from function root) often places it.
    const deployedPathRoot = path.resolve(__dirname, 'graph_config.json');

    // 2. If __dirname is something like /var/task/src/ after bundling, and the file was copied to /var/task/src/
    //    (Less likely with included_files from function root, more likely if it was in src/ and bundled from there without specific include rules)
    const deployedPathInSrcEquivalent = path.resolve(__dirname, 'graph_config.json'); // Same as above if __dirname is /var/task

    // 3. The path from your error log (just in case __dirname is /var/task/ and it's nested)
    //    This path seems less likely for included_files = ["graph_config.json"] from function root.
    const errorLogPath = '/var/task/netlify/functions/headline_analyzer/graph_config.json';


    let pathToTry;
    let foundPath = null;

    console.log(`[GRAPH_BUILDER] Current __dirname: ${__dirname}`);

    // Check local dev path first
    if ((process.env.NETLIFY_DEV || process.env.NODE_ENV === 'development') && __dirname.includes(path.join('headline_analyzer', 'src'))) {
        console.log(`[GRAPH_BUILDER] Detected local dev structure. Trying local path: ${localDevConfigPath}`);
        if (fs.existsSync(localDevConfigPath)) {
            foundPath = localDevConfigPath;
        }
    }

    // If not found locally, try common deployed paths
    if (!foundPath) {
        console.log(`[GRAPH_BUILDER] Not found locally or not in local dev mode. Trying deployed paths.`);
        const pathsToTryInDeployment = [
            deployedPathRoot, // Try /var/task/graph_config.json (most likely for included_files)
            // errorLogPath, // The path from your error - might be a red herring but worth a check if others fail
            // deployedPathInSrcEquivalent, // if src/ content is put in /var/task/src/ (less likely for toplevel included_files)
        ];
        
        // Add the errorLogPath only if it's different from deployedPathRoot to avoid redundant checks
        // and to explicitly test the path from the error message.
        // However, given the error path IS deployedPathRoot in your last error, let's simplify.
        // The error indicates it *is* looking at /var/task/netlify/functions/headline_analyzer/graph_config.json
        // This means __dirname at that point of code execution IS /var/task/netlify/functions/headline_analyzer/
        // So, path.resolve(__dirname, 'graph_config.json') IS /var/task/netlify/functions/headline_analyzer/graph_config.json

        // The last error log path WAS: /var/task/netlify/functions/headline_analyzer/graph_config.json
        // This implies that within the bundled code, __dirname = /var/task/netlify/functions/headline_analyzer/
        // Therefore, path.resolve(__dirname, 'graph_config.json') would correctly target this.
        // The problem is simply that the file ISN'T THERE.

        // Let's stick to the most likely scenario for included_files = ["graph_config.json"]
        // which places the file at the root of /var/task/
        // If your __dirname for loadGraphDefinition (which is part of the main bundle) is /var/task/
        // then path.resolve(__dirname, 'graph_config.json') looks for /var/task/graph_config.json.

        // The previous log showed:
        // [GRAPH_BUILDER] Attempting to load graph_config.json from: /var/task/netlify/functions/headline_analyzer/graph_config.json
        // This means that at the point `loadGraphDefinition` runs, `__dirname` is `/var/task/netlify/functions/headline_analyzer/`
        // AND your `deployedPathAttempt` was `path.resolve(__dirname, 'graph_config.json')`.
        // So the code *is* looking in the right place based on that __dirname.

        // THE ISSUE: `included_files = ["graph_config.json"]` when graph_config.json is at
        // `repo_root/netlify/functions/headline_analyzer/graph_config.json`
        // SHOULD place it at `/var/task/graph_config.json` (the root of the unzipped function).
        // It does NOT create the `netlify/functions/headline_analyzer/` subdirectory structure inside `/var/task/` for this file.

        // THEREFORE, your code should try to load from `/var/task/graph_config.json`.
        // If `__dirname` is `/var/task/netlify/functions/headline_analyzer/` (as implied by the error path),
        // then you need to go up a few levels.

        const tryPath1 = path.resolve(__dirname, '../../graph_config.json'); // from /var/task/netlify/functions/headline_analyzer/ up to /var/task/
        console.log(`[GRAPH_BUILDER] Deployed attempt 1: ${tryPath1}`);
        if (fs.existsSync(tryPath1)) {
            foundPath = tryPath1;
        }

        if (!foundPath) {
            const tryPath2 = path.resolve(__dirname, '../graph_config.json'); // from /var/task/netlify/functions/headline_analyzer/ up to /var/task/netlify/functions/
            console.log(`[GRAPH_BUILDER] Deployed attempt 2 (less likely for include_files): ${tryPath2}`);
             if (fs.existsSync(tryPath2)) {
                foundPath = tryPath2;
            }
        }
        
        if (!foundPath) {
            const tryPath3 = path.resolve(__dirname, 'graph_config.json'); // The path that errored out before
            console.log(`[GRAPH_BUILDER] Deployed attempt 3 (path from previous error): ${tryPath3}`);
            if (fs.existsSync(tryPath3)) {
                foundPath = tryPath3;
            }
        }
    }


    if (!foundPath) {
        console.error(`FATAL: Graph configuration file not found after trying multiple paths.`);
        // Log directory contents for debugging in deployment
        try {
            console.log(`[GRAPH_BUILDER] Contents of __dirname (${__dirname}):`, fs.readdirSync(__dirname));
            const rootTaskDir = path.resolve(__dirname, '../../'); // Attempt to list /var/task
            if (fs.existsSync(rootTaskDir) && rootTaskDir.includes('var/task')) { // Basic sanity check
                 console.log(`[GRAPH_BUILDER] Contents of likely /var/task/ (${rootTaskDir}):`, fs.readdirSync(rootTaskDir));
            }
            const parentDir = path.resolve(__dirname, '..');
             if (fs.existsSync(parentDir)) {
                 console.log(`[GRAPH_BUILDER] Contents of parent dir (${parentDir}):`, fs.readdirSync(parentDir));
            }

        } catch (e) {
            console.error("[GRAPH_BUILDER] Error reading directory for debug:", e.message);
        }
        throw new Error(`Graph configuration file could not be located.`);
    }

    console.log(`[GRAPH_BUILDER] Successfully found and using graph_config.json at: ${foundPath}`);
    const rawConfig = fs.readFileSync(foundPath, 'utf-8');
    try {
        return JSON.parse(rawConfig);
    } catch (e) {
        console.error(`Error parsing graph_config.json from ${foundPath}: ${e.message}`);
        throw e;
    }
}
function buildGraph() {
    const { nodeDefinitions, graphEdges, entryPointNodeId } = loadGraphDefinition();

    if (!nodeDefinitions || nodeDefinitions.length === 0) {
        throw new Error("No nodeDefinitions found in graph_config.json. Cannot build graph.");
    }

    const appGraph = new StateGraph({ channels: appStateChannels });

    // Add all nodes defined in nodeDefinitions
    for (const nodeConfig of nodeDefinitions) {
        let langGraphNodeFunction;

        switch (nodeConfig.type) {
            case 'llm_agent':
                langGraphNodeFunction = async (state) => {
                    // console.log(`GraphBuilder: Invoking llm_agent node ${nodeConfig.id} with state:`, Object.keys(state));
                    return await executeLlmAgentNode(state, nodeConfig);
                };
                break;
            case 'local_function':
                if (customNodeFunctions[nodeConfig.functionName]) {
                    langGraphNodeFunction = async (state) => {
                        // console.log(`GraphBuilder: Invoking local_function node ${nodeConfig.id} (${nodeConfig.functionName}) with state:`, Object.keys(state));
                        return await customNodeFunctions[nodeConfig.functionName](state, nodeConfig);
                    };
                } else {
                    console.error(`Error: Local function '${nodeConfig.functionName}' for node '${nodeConfig.id}' not found in customNodeFunctions.`);
                    langGraphNodeFunction = async (state) => ({
                        [`${nodeConfig.id}_error`]: `Configuration error: Local function ${nodeConfig.functionName} not found.`,
                        error_messages: [`Configuration error for ${nodeConfig.id}: Local function ${nodeConfig.functionName} not found.`]
                    });
                }
                break;
            case 'parallel_llm_group_coordinator':
                langGraphNodeFunction = async (state) => {
                    console.log(`--- Running Parallel LLM Group Coordinator: ${nodeConfig.displayName} (ID: ${nodeConfig.id}) ---`);
                    const update = { error_messages: [] }; // To collect errors from sub-tasks

                    // Determine headlineToAnalyze (used by all sub-tasks)
                    let headlineToAnalyze;
                    if (nodeConfig.stateInputArgs && nodeConfig.stateInputArgs.headline_with_placeholders && state[nodeConfig.stateInputArgs.headline_with_placeholders]) {
                        headlineToAnalyze = state[nodeConfig.stateInputArgs.headline_with_placeholders];
                    } else if (nodeConfig.stateInputArgs && nodeConfig.stateInputArgs.input_headline && state[nodeConfig.stateInputArgs.input_headline]) {
                        headlineToAnalyze = state[nodeConfig.stateInputArgs.input_headline];
                    } else {
                        headlineToAnalyze = state.headline_with_placeholders || state.input_headline || "";
                    }
                    
                    // Ensure headlineToAnalyze is in the state for downstream nodes (like synthesizer)
                    // This state key should be defined in state_definition.js
                    update.headlineToAnalyze = headlineToAnalyze;


                    if (!headlineToAnalyze && nodeConfig.analyzerTasks && nodeConfig.analyzerTasks.length > 0) {
                        console.warn(`${nodeConfig.id}: No headline to analyze. Skipping all sub-tasks.`);
                        nodeConfig.analyzerTasks.forEach(taskConfig => {
                            update[taskConfig.stateOutputKey] = { error: "No input headline for analysis.", rawContent: "" };
                            update.error_messages.push(`${taskConfig.displayName}: No input headline for analysis.`);
                        });
                        return update;
                    }
                    
                    if (!nodeConfig.analyzerTasks || nodeConfig.analyzerTasks.length === 0) {
                        console.warn(`${nodeConfig.id}: No analyzerTasks defined. Coordinator will do nothing.`);
                        return update;
                    }

                    const analyzerPromises = nodeConfig.analyzerTasks.map(async (taskConfig) => {
                        console.log(`--- Starting parallel sub-task: ${taskConfig.displayName} (via ${nodeConfig.id}) ---`);
                        if (!taskConfig.promptConfig) {
                             console.error(`Error: Prompt config missing for analyzer task ${taskConfig.displayName} in ${nodeConfig.id}`);
                             return { [taskConfig.stateOutputKey]: { error: `Prompt config missing for ${taskConfig.displayName}` } };
                        }
                        const taskPromptData = { ...state, headlineToAnalyze }; // Pass full state + specific headline
                        
                        const messages = [
                            { role: 'system', content: interpolateTemplate(taskConfig.promptConfig.systemMessage, taskPromptData) },
                            { role: 'developer', content: interpolateTemplate(taskConfig.promptConfig.developerInstructionsTemplate, taskPromptData) },
                            { role: 'user', content: interpolateTemplate(taskConfig.promptConfig.userInputTemplate, taskPromptData) }
                        ];
                        const llmResult = await callModel(messages); // callModel from llm_utils.js
                        if (llmResult.error) {
                            update.error_messages.push(`${taskConfig.displayName}: ${llmResult.error}`);
                        }
                        return { [taskConfig.stateOutputKey]: llmResult };
                    });

                    const settledResults = await Promise.allSettled(analyzerPromises);
                    settledResults.forEach(promiseResult => {
                        if (promiseResult.status === 'fulfilled') {
                            Object.assign(update, promiseResult.value);
                        } else {
                            // This error should ideally be caught within the promise and returned in llmResult.error
                            console.error(`${nodeConfig.id}: A parallel analyzer promise was rejected:`, promiseResult.reason);
                            // How to map this to a specific task's output key if the task ID isn't easily available here?
                            // For now, rely on errors being captured in llmResult.error by callModel.
                            update.error_messages.push(`${nodeConfig.id}: A sub-task promise rejected: ${promiseResult.reason?.message || 'Unknown error'}`);
                        }
                    });
                    return update;
                };
                break;
            default:
                console.warn(`Warning: Node type '${nodeConfig.type}' for node '${nodeConfig.id}' is not recognized. Creating a pass-through node.`);
                langGraphNodeFunction = async (state) => {
                    console.log(`Passing through unrecognized node: ${nodeConfig.id}`);
                    return {
                         error_messages: [`Unrecognized node type for ${nodeConfig.id}: ${nodeConfig.type}`]
                    };
                };
        }
        appGraph.addNode(nodeConfig.id, langGraphNodeFunction);
    }

    // Set the entry point
    if (!entryPointNodeId || !nodeDefinitions.find(n => n.id === entryPointNodeId)) {
        const fallbackEntryPoint = nodeDefinitions.length > 0 ? nodeDefinitions[0].id : null;
        if (!fallbackEntryPoint) {
            throw new Error("No nodes defined in graph_config.json to set an entry point.");
        }
        console.warn(`EntryPointNodeId '${entryPointNodeId}' from graph_config.json is invalid or not found. Falling back to '${fallbackEntryPoint}'.`);
        appGraph.setEntryPoint(fallbackEntryPoint);
    } else {
        appGraph.setEntryPoint(entryPointNodeId);
    }

    // Add edges
    if (graphEdges && graphEdges.length > 0) {
        for (const edge of graphEdges) {
            if (!nodeDefinitions.find(n => n.id === edge.source)) {
                console.warn(`Warning: Source node '${edge.source}' in edge definition not found in nodeDefinitions. Skipping edge.`);
                continue;
            }
            // MODIFICATION HERE:
            if (edge.target !== END && !nodeDefinitions.find(n => n.id === edge.target)) {
                console.warn(`Warning: Target node '${edge.target}' in edge definition not found in nodeDefinitions (and it's not END). Skipping edge.`);
                continue;
            }
            // END OF MODIFICATION
            appGraph.addEdge(edge.source, edge.target);
        }
    } else {
        console.warn("No graphEdges defined in graph_config.json. The graph might not be fully connected.");
    }


    try {
        const compiledGraph = appGraph.compile();
        console.log("LangGraph app compiled successfully.");
        return {
            compiledGraph,
            // Provide loaded definitions for client/handler if needed (e.g., for constructing 'graphStructure')
            loadedNodeDefinitions: nodeDefinitions.map(n => ({
                id: n.id,
                displayName: n.displayName,
                type: n.type, // Original type from config
                clientNodeType: n.type, // Could be refined for client display
                stateOutputKey: n.stateOutputKey,
                // For parallel group, provide sub-task display names and their output keys
                subTasks: n.type === "parallel_llm_group_coordinator" && n.analyzerTasks
                    ? n.analyzerTasks.map(st => ({
                        id: st.id, // Internal ID of sub-task
                        displayName: st.displayName,
                        stateOutputKey: st.stateOutputKey
                    }))
                    : undefined
            }))
        };
    } catch (e) {
        console.error("Error compiling LangGraph:", e);
        throw e;
    }
}

// Build the graph when this module is loaded
const { compiledGraph, loadedNodeDefinitions } = buildGraph();

module.exports = {
  app: compiledGraph,
  nodeDefinitionsForClient: loadedNodeDefinitions, // Export for Netlify handler or local runner
};