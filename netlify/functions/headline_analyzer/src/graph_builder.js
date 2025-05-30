// src/graph_builder.js
const { StateGraph, END } = require('@langchain/langgraph');
// const fs = require('fs');
// const path = require('path');

const graphConfig = require('./graph_config.json'); // <--- THE HACK
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

// function loadGraphDefinition() {
//     // Path for local development:
//     // Assumes graph_builder.js is in '.../headline_analyzer/src/'
//     // and graph_config.json is in '.../headline_analyzer/graph_config.json'
//     const localDevConfigPath = path.resolve(__dirname, '../graph_config.json');

//     // Path for deployed Lambda environment:
//     // Assumes included_files = ["graph_config.json"] (from function root)
//     // places graph_config.json at /var/task/graph_config.json.
//     // And __dirname (for loadGraphDefinition in bundle) is /var/task/netlify/functions/headline_analyzer/
//     // So, we need to go up three levels from __dirname to reach /var/task/
//     const deployedLambdaPath = path.resolve(__dirname, '../../../graph_config.json');

//     let pathToTry;
//     let foundPath = null;

//     console.log(`[GRAPH_BUILDER] Current __dirname: ${__dirname}`);

//     // Check local dev path first
//     // Adjusted local dev check: if .env is present one level up (project root for local)
//     // or if NETLIFY_DEV is set, and the local path exists.
//     const isLikelyLocalDev = (process.env.NETLIFY_DEV || process.env.NODE_ENV === 'development');
    
//     if (isLikelyLocalDev && __dirname.includes(path.join('headline_analyzer', 'src'))) {
//         console.log(`[GRAPH_BUILDER] Detected local dev structure. Trying local path: ${localDevConfigPath}`);
//         if (fs.existsSync(localDevConfigPath)) {
//             foundPath = localDevConfigPath;
//         }
//     }

//     // If not found locally, or not local dev, try the deployed Lambda path
//     if (!foundPath) {
//         console.log(`[GRAPH_BUILDER] Not found locally or not in local dev mode. Trying deployed Lambda path: ${deployedLambdaPath}`);
//         if (fs.existsSync(deployedLambdaPath)) {
//             foundPath = deployedLambdaPath;
//         }
//     }

//     if (!foundPath) {
//         console.error(`FATAL: Graph configuration file not found after trying a_paths.`);
//         console.error(`  Tried local path: ${localDevConfigPath} (exists: ${fs.existsSync(localDevConfigPath)})`);
//         console.error(`  Tried deployed path: ${deployedLambdaPath} (exists: ${fs.existsSync(deployedLambdaPath)})`);
        
//         // Log directory contents for debugging in deployment
//         try {
//             console.log(`[GRAPH_BUILDER] Contents of __dirname (${__dirname}):`, fs.readdirSync(__dirname)); // Should be ['headline_analyzer.js']
//             const dirLevel1Up = path.resolve(__dirname, '..'); // /var/task/netlify/functions/
//             console.log(`[GRAPH_BUILDER] Contents of ${dirLevel1Up}:`, fs.readdirSync(dirLevel1Up)); // Should be ['headline_analyzer']
//             const dirLevel2Up = path.resolve(__dirname, '../..'); // /var/task/netlify/
//             console.log(`[GRAPH_BUILDER] Contents of ${dirLevel2Up}:`, fs.readdirSync(dirLevel2Up)); // Should be ['functions']
//             const dirLevel3Up = path.resolve(__dirname, '../../..'); // /var/task/
//             console.log(`[GRAPH_BUILDER] Contents of ${dirLevel3Up} (expected /var/task/):`, fs.readdirSync(dirLevel3Up)); // Should show graph_config.json here
//         } catch (e) {
//             console.error("[GRAPH_BUILDER] Error reading directory for debug:", e.message);
//         }
//         throw new Error(`Graph configuration file could not be located after checking common paths.`);
//     }

//     console.log(`[GRAPH_BUILDER] Successfully found and using graph_config.json at: ${foundPath}`);
//     const rawConfig = fs.readFileSync(foundPath, 'utf-8');
//     try {
//         return JSON.parse(rawConfig);
//     } catch (e) {
//         console.error(`Error parsing graph_config.json from ${foundPath}: ${e.message}`);
//         throw e;
//     }
// }

function buildGraph() {
    const { nodeDefinitions, graphEdges, entryPointNodeId } = graphConfig;

    if (!nodeDefinitions || nodeDefinitions.length === 0) {
        console.error("FATAL: No nodeDefinitions found in the imported graph_config.json.");
        throw new Error("No nodeDefinitions found in graph_config.json. Cannot build graph.");
    }
    if (!graphConfig) { // Should not happen if require works
         console.error("FATAL: graph_config.json was not imported correctly.");
         throw new Error("graph_config.json import failed.");
    }

    const appGraph = new StateGraph({ channels: appStateChannels });

    // Add all nodes defined in nodeDefinitions ...
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