const { StateGraph, END } = require('@langchain/langgraph');
const { llmNode, customNodeFunctions } = require('./node_functions');
const { getAppStateChannels } = require('./state_definition'); // Assuming AppState defined here

function compileGraph(graphConfig) {
    const appStateChannels = getAppStateChannels(graphConfig.appStateChannels);
    const appGraph = new StateGraph({ channels: appStateChannels });

    // Add nodes
    graphConfig.nodes.forEach(nodeConfig => {
        if (nodeConfig.type === 'llm_node') {
            appGraph.addNode(nodeConfig.id, (state) => llmNode(state, graphConfig, nodeConfig));
        } else if (nodeConfig.type === 'custom_js_node') {
            const func = customNodeFunctions[nodeConfig.functionName];
            if (func) {
                appGraph.addNode(nodeConfig.id, (state) => func(state, graphConfig, nodeConfig));
            } else {
                console.error(`Custom function ${nodeConfig.functionName} not found for node ${nodeConfig.id}`);
                // Add a dummy node that signals an error
                appGraph.addNode(nodeConfig.id, () => ({ error_message: `Custom function ${nodeConfig.functionName} not found.`}));
            }
        } else if (nodeConfig.type === 'parallel_node') {
            // This node type is a logical grouping. LangGraph handles parallelism by how edges are defined.
            // If multiple edges originate from one node, those branches can run in parallel.
            // We will create a "passthrough" node or manage branching directly via edges.
            // For now, we'll assume it's a conceptual node and edges define actual parallelism.
            // A simple passthrough node:
            appGraph.addNode(nodeConfig.id, (state) => {
                console.log(`--- Passing through parallel grouping node: ${nodeConfig.id} ---`);
                return {}; // No state change, just a routing point
            });
        }
        // Add more node types if needed (e.g., conditional_node)
    });

    // Add edges
    let entryPointSet = false;
    graphConfig.edges.forEach(edgeConfig => {
        if (edgeConfig.source === '__START__') {
            appGraph.setEntryPoint(edgeConfig.target);
            entryPointSet = true;
        } else if (edgeConfig.target === '__END__') {
            appGraph.addEdge(edgeConfig.source, END);
        } else {
            // Here you could add conditional edge logic if nodeConfig.type was 'conditional_edge_router'
            // For now, all edges are direct
            appGraph.addEdge(edgeConfig.source, edgeConfig.target);
        }
    });

    if (!entryPointSet && graphConfig.nodes.length > 0) {
        console.warn("No __START__ edge found, attempting to set first node as entry point.");
        const firstNode = graphConfig.edges.find(e => e.source === "__START__")?.target || graphConfig.nodes[0]?.id;
        if (firstNode) {
            appGraph.setEntryPoint(firstNode);
        } else {
            throw new Error("Graph has no nodes or __START__ edge to define an entry point.");
        }
    }
    
    return appGraph.compile();
}

module.exports = { compileGraph };