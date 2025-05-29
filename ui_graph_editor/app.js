document.addEventListener('DOMContentLoaded', () => {
    let graphConfig = createEmptyGraphConfig(); // Initialize with a default structure

    const loadConfigBtn = document.getElementById('loadConfig');
    const fileInput = document.getElementById('fileInput');
    const saveConfigBtn = document.getElementById('saveConfig');
    const newGraphBtn = document.getElementById('newGraph');
    
    const nodesList = document.getElementById('nodesList');
    const addNodeBtn = document.getElementById('addNodeBtn');
    
    const promptSelector = document.getElementById('promptSelector');
    const promptEditor = document.getElementById('promptEditor');
    const addPromptBtn = document.getElementById('addPromptBtn');

    const edgesList = document.getElementById('edgesList');
    const addEdgeBtn = document.getElementById('addEdgeBtn');

    const appStateChannelsEditor = document.getElementById('appStateChannelsEditor');
    const addChannelBtn = document.getElementById('addChannelBtn');
    
    const graphApiStructureEditor = document.getElementById('graphApiStructureEditor');


    function createEmptyGraphConfig() {
        return {
            appStateChannels: { /* basic example */ },
            prompts: {},
            nodes: [],
            edges: [],
            graphApiStructure: { nodes: [] }
        };
    }

    function renderAll() {
        renderNodes();
        renderPromptSelector();
        renderEdges();
        renderAppStateChannels();
        renderGraphApiStructure();
        // If a prompt is selected, render its editor too
        if (promptSelector.value) {
            renderPromptEditor(promptSelector.value);
        }
    }

    // --- File Handling ---
    loadConfigBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const loadedData = JSON.parse(e.target.result);
                    // Ensure appStateChannels values remain strings
                    // This should be the default behavior of JSON.parse,
                    // but let's be explicit if any other processing happens.
                    graphConfig = loadedData; // Directly assign parsed JSON
                    renderAll();
                    alert('Configuration loaded!');
                } catch (err) {
                    alert('Error parsing JSON file: ' + err.message);
                }
            };
            reader.readAsText(file);
            fileInput.value = '';
        }
    });

    saveConfigBtn.addEventListener('click', () => {
        console.log("Saving graphConfig.appStateChannels:", graphConfig.appStateChannels); // DEBUG
        // Check if any channel value or default is a function
        for (const key in graphConfig.appStateChannels) {
            const channel = graphConfig.appStateChannels[key];
            if (typeof channel.value === 'function') {
                alert(`Error: appStateChannel '${key}'.value is a function, should be a string. Fix UI logic.`);
                console.error(`Channel ${key}.value is a function:`, channel.value);
                return; // Prevent saving broken config
            }
            if (typeof channel.default === 'function') {
                alert(`Error: appStateChannel '${key}'.default is a function, should be a string. Fix UI logic.`);
                console.error(`Channel ${key}.default is a function:`, channel.default);
                return; // Prevent saving broken config
            }
        }
        const jsonString = JSON.stringify(graphConfig, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'graph_config.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        alert('Configuration saved! Place this file in netlify/functions/headline_analyzer/');
    });

    newGraphBtn.addEventListener('click', () => {
        if (confirm("Are you sure you want to create a new empty graph? Unsaved changes will be lost.")) {
            graphConfig = createEmptyGraphConfig();
            renderAll();
        }
    });

    // --- Nodes ---
    function renderNodes() {
        nodesList.innerHTML = '';
        graphConfig.nodes.forEach((node, index) => {
            const li = document.createElement('li');
            li.innerHTML = `
                Node ID: <input type="text" class="node-prop" data-index="${index}" data-prop="id" value="${node.id}">
                Type: <select class="node-prop" data-index="${index}" data-prop="type">
                          <option value="llm_node" ${node.type === 'llm_node' ? 'selected' : ''}>LLM Node</option>
                          <option value="custom_js_node" ${node.type === 'custom_js_node' ? 'selected' : ''}>Custom JS Node</option>
                          <option value="parallel_node" ${node.type === 'parallel_node' ? 'selected' : ''}>Parallel Group (Conceptual)</option>
                          <option value="passthrough_node" ${node.type === 'passthrough_node' ? 'selected' : ''}>Passthrough</option>
                      </select>
                ${node.type === 'llm_node' ? `Prompt ID: <input type="text" class="node-prop" data-index="${index}" data-prop="promptId" value="${node.promptId || ''}">` : ''}
                ${node.type === 'custom_js_node' ? `Function Name: <input type="text" class="node-prop" data-index="${index}" data-prop="functionName" value="${node.functionName || ''}">` : ''}
                <button class="delete-node" data-index="${index}">X</button>
            `;
            nodesList.appendChild(li);
        });
        // Add event listeners for inputs and delete buttons
        document.querySelectorAll('.node-prop').forEach(input => {
            input.addEventListener('change', updateNodeProperty);
        });
        document.querySelectorAll('.delete-node').forEach(button => {
            button.addEventListener('click', deleteNode);
        });
    }

    addNodeBtn.addEventListener('click', () => {
        const newNodeId = prompt("Enter new node ID:", `node${graphConfig.nodes.length + 1}`);
        if (newNodeId) {
            graphConfig.nodes.push({ id: newNodeId, type: 'llm_node', promptId: '' });
            renderNodes();
        }
    });

    function updateNodeProperty(event) {
        const index = parseInt(event.target.dataset.index);
        const prop = event.target.dataset.prop;
        graphConfig.nodes[index][prop] = event.target.value;
        if (prop === 'type') renderNodes(); // Re-render if type changes to show/hide relevant fields
    }

    function deleteNode(event) {
        const index = parseInt(event.target.dataset.index);
        if (confirm(`Are you sure you want to delete node "${graphConfig.nodes[index].id}"?`)) {
            graphConfig.nodes.splice(index, 1);
            // Also remove edges connected to this node
            graphConfig.edges = graphConfig.edges.filter(edge => edge.source !== graphConfig.nodes[index]?.id && edge.target !== graphConfig.nodes[index]?.id);
            renderNodes();
            renderEdges();
        }
    }
    
    // --- Prompts ---
    function renderPromptSelector() {
        promptSelector.innerHTML = '<option value="">-- Select a Prompt --</option>';
        Object.keys(graphConfig.prompts).forEach(promptId => {
            const option = document.createElement('option');
            option.value = promptId;
            option.textContent = promptId;
            promptSelector.appendChild(option);
        });
    }

    promptSelector.addEventListener('change', (event) => {
        renderPromptEditor(event.target.value);
    });

    addPromptBtn.addEventListener('click', () => {
        const newPromptId = prompt("Enter new prompt ID (e.g., MY_NEW_ANALYZER):");
        if (newPromptId && !graphConfig.prompts[newPromptId]) {
            graphConfig.prompts[newPromptId] = {
                id: newPromptId,
                description: "",
                model: "gemini-1.5-flash-latest",
                messages_template: [
                    {role: "system", content: ""},
                    {role: "developer", content: "Instructions:\nRequired JSON Output Schema:\n```json\n{{{json_schema}}}\n```\nExamples:\n{{#examples}}\nInput: \"{{input}}\"\nOutput:\n```json\n{{{output_json_string}}}\n```\n{{/examples}}"},
                    {role: "user", content: ""}
                ],
                json_schema: { type: "object", properties: {}, required: [] },
                examples: [],
                input_mapping: {},
                output_mapping: {}
            };
            renderPromptSelector();
            promptSelector.value = newPromptId;
            renderPromptEditor(newPromptId);
        } else if (newPromptId) {
            alert("Prompt ID already exists!");
        }
    });

    function renderPromptEditor(promptId) {
        promptEditor.innerHTML = '';
        if (!promptId || !graphConfig.prompts[promptId]) return;

        const prompt = graphConfig.prompts[promptId];
        // Create textareas for system, developer, user messages
        // Create textarea for JSON schema (stringify/parse on load/save)
        // Create UI for examples (add/remove, input/output textareas)
        // Create UI for input_mapping and output_mapping (key-value pairs)
        // ... this part can get quite detailed ...
        // Example for description:
        promptEditor.innerHTML = `
            <h3>Editing: ${promptId} <button id="deleteCurrentPrompt">Delete This Prompt</button></h3>
            <div><label>Description: <input type="text" id="promptDesc" value="${prompt.description}"></label></div>
            <div><label>Model: <input type="text" id="promptModel" value="${prompt.model}"></label></div>
            <h4>Messages Template:</h4>
            ${prompt.messages_template.map((msg, index) => `
                <div>
                    Role: <input type="text" class="prompt-msg-role" data-index="${index}" value="${msg.role}">
                    Content: <textarea class="prompt-msg-content" data-index="${index}" rows="5">${msg.content}</textarea>
                </div>
            `).join('')}
            <h4>JSON Schema:</h4>
            <textarea id="promptJsonSchema" rows="10">${JSON.stringify(prompt.json_schema, null, 2)}</textarea>
            <h4>Examples: <button id="addExampleBtn">Add Example</button></h4>
            <div id="promptExamples">
            ${prompt.examples.map((ex, i) => `
                <div class="example-item">
                    Input: <textarea class="example-input" data-index="${i}" rows="2">${ex.input}</textarea>
                    Output (JSON String): <textarea class="example-output" data-index="${i}" rows="3">${ex.output_json_string}</textarea>
                    <button class="delete-example" data-index="${i}">Remove</button>
                </div>
            `).join('')}
            </div>
            <h4>Input Mapping (State Key -> Template Var):</h4>
            <div id="promptInputMapping">${renderMappingUI(prompt.input_mapping, 'input')}</div>
            <button id="addInputMapBtn">Add Input Map</button>
            <h4>Output Mapping (State Key -> LLM Output Key / '.' for whole):</h4>
            <div id="promptOutputMapping">${renderMappingUI(prompt.output_mapping, 'output')}</div>
            <button id="addOutputMapBtn">Add Output Map</button>
        `;

        // Add event listeners for all these new fields
        document.getElementById('promptDesc').addEventListener('change', (e) => graphConfig.prompts[promptId].description = e.target.value);
        document.getElementById('promptModel').addEventListener('change', (e) => graphConfig.prompts[promptId].model = e.target.value);
        // ... for messages, schema, examples, mappings ...
        document.getElementById('promptJsonSchema').addEventListener('blur', (e) => {
            try {
                graphConfig.prompts[promptId].json_schema = JSON.parse(e.target.value);
            } catch (err) {
                alert('Invalid JSON schema: ' + err.message);
                e.target.value = JSON.stringify(graphConfig.prompts[promptId].json_schema, null, 2); // revert
            }
        });
        // Example for add/delete example
        document.getElementById('addExampleBtn').addEventListener('click', () => {
            graphConfig.prompts[promptId].examples.push({input: "", output_json_string: "{}"});
            renderPromptEditor(promptId);
        });
        document.querySelectorAll('.delete-example').forEach(btn => btn.addEventListener('click', (e) => {
            const exIndex = parseInt(e.target.dataset.index);
            graphConfig.prompts[promptId].examples.splice(exIndex, 1);
            renderPromptEditor(promptId);
        }));
         document.getElementById('deleteCurrentPrompt').addEventListener('click', () => {
            if (confirm(`Are you sure you want to delete prompt "${promptId}"?`)) {
                delete graphConfig.prompts[promptId];
                promptEditor.innerHTML = '';
                renderPromptSelector();
            }
        });
        // ... and so on for other fields and add/delete mapping buttons
    }
    
    function renderMappingUI(mappingObject, typePrefix) {
        let html = '';
        for (const key in mappingObject) {
            html += `<div>
                <input type="text" class="map-key-${typePrefix}" value="${key}" data-orig-key="${key}"> -> 
                <input type="text" class="map-value-${typePrefix}" value="${mappingObject[key]}" data-key="${key}">
                <button class="delete-map-${typePrefix}" data-key="${key}">X</button>
            </div>`;
        }
        return html;
    }


    // --- Edges ---
    function renderEdges() {
        edgesList.innerHTML = '';
        const nodeIds = ['__START__', ...graphConfig.nodes.map(n => n.id), '__END__'];

        graphConfig.edges.forEach((edge, index) => {
            const li = document.createElement('li');
            let sourceOptions = nodeIds.filter(id => id !== '__END__').map(id => `<option value="${id}" ${edge.source === id ? 'selected' : ''}>${id}</option>`).join('');
            let targetOptions = nodeIds.filter(id => id !== '__START__').map(id => `<option value="${id}" ${edge.target === id ? 'selected' : ''}>${id}</option>`).join('');
            
            li.innerHTML = `
                From: <select class="edge-prop" data-index="${index}" data-prop="source">${sourceOptions}</select>
                To: <select class="edge-prop" data-index="${index}" data-prop="target">${targetOptions}</select>
                <button class="delete-edge" data-index="${index}">X</button>
            `;
            edgesList.appendChild(li);
        });
        document.querySelectorAll('.edge-prop').forEach(input => {
            input.addEventListener('change', updateEdgeProperty);
        });
        document.querySelectorAll('.delete-edge').forEach(button => {
            button.addEventListener('click', deleteEdge);
        });
    }
    
    addEdgeBtn.addEventListener('click', () => {
        graphConfig.edges.push({ source: '__START__', target: graphConfig.nodes[0]?.id || '__END__'});
        renderEdges();
    });

    function updateEdgeProperty(event) {
        const index = parseInt(event.target.dataset.index);
        const prop = event.target.dataset.prop;
        graphConfig.edges[index][prop] = event.target.value;
    }

    function deleteEdge(event) {
        const index = parseInt(event.target.dataset.index);
        graphConfig.edges.splice(index, 1);
        renderEdges();
    }

    // --- AppState Channels & Graph API Structure ---
    // Implement renderAppStateChannels, renderGraphApiStructure and their editors similarly
    // For appStateChannels, you'll need text inputs for value and default (which are function strings)
    // For graphApiStructure, it's an array of objects, so a similar list UI to nodes/edges.

    function renderAppStateChannels() {
        appStateChannelsEditor.innerHTML = '';
        Object.entries(graphConfig.appStateChannels).forEach(([key, channelDef]) => {
            const div = document.createElement('div');
            // Ensure channelDef.value and channelDef.default are treated as strings
            div.innerHTML = `
                Channel Key: <input type="text" class="channel-key" value="${key}" data-orig-key="${key}">
                Value Fn (string): <input type="text" class="channel-prop" data-channel-key="${key}" data-prop="value" value="${escapeHtml(String(channelDef.value))}">
                Default Fn (string): <input type="text" class="channel-prop" data-channel-key="${key}" data-prop="default" value="${escapeHtml(String(channelDef.default || ''))}">
                <button class="delete-channel" data-key="${key}">X</button>
            `;
            appStateChannelsEditor.appendChild(div);
        });

        document.querySelectorAll('#appStateChannelsEditor .channel-key').forEach(input => {
            input.addEventListener('change', updateAppStateChannelKey);
        });
        document.querySelectorAll('#appStateChannelsEditor .channel-prop').forEach(input => {
            input.addEventListener('change', updateAppStateChannelProp);
        });
        document.querySelectorAll('#appStateChannelsEditor .delete-channel').forEach(button => {
            button.addEventListener('click', deleteAppStateChannel);
        });
    }

    function updateAppStateChannelKey(event) {
        const oldKey = event.target.dataset.origKey;
        const newKey = event.target.value;
        if (newKey && newKey !== oldKey) {
            if (graphConfig.appStateChannels[newKey]) {
                alert(`Channel key "${newKey}" already exists!`);
                event.target.value = oldKey; // Revert
                return;
            }
            const channelData = graphConfig.appStateChannels[oldKey];
            delete graphConfig.appStateChannels[oldKey];
            graphConfig.appStateChannels[newKey] = channelData;
            renderAppStateChannels(); // Re-render to update data attributes
        } else if (!newKey) {
            alert("Channel key cannot be empty.");
            event.target.value = oldKey; // Revert
        }
    }

    function updateAppStateChannelProp(event) {
        const key = event.target.dataset.channelKey;
        const prop = event.target.dataset.prop;
        // Store the value directly as a string. DO NOT EVALUATE IT HERE.
        graphConfig.appStateChannels[key][prop] = event.target.value;
    }

    function deleteAppStateChannel(event) {
        const key = event.target.dataset.key;
        if (confirm(`Are you sure you want to delete AppState channel "${key}"?`)) {
            delete graphConfig.appStateChannels[key];
            renderAppStateChannels();
        }
    }

    addChannelBtn.addEventListener('click', () => {
        const newKey = prompt("Enter new AppState channel key:");
        if (newKey && !graphConfig.appStateChannels[newKey]) {
            graphConfig.appStateChannels[newKey] = { value: "(x, y) => y", default: "() => undefined" };
            renderAppStateChannels();
        } else if (newKey) {
            alert(`Channel key "${newKey}" already exists!`);
        }
    });

    // Helper to prevent issues if values contain HTML special chars
    function escapeHtml(unsafe) {
        if (typeof unsafe !== 'string') return unsafe;
        return unsafe
            .replace(/&/g, "&")
            .replace(/</g, "<")
            .replace(/>/g, ">")
            .replace(/"/g, "\"")
            .replace(/'/g, "'");
    }
    function renderGraphApiStructure() {
        // Similar to renderNodes, but for graphConfig.graphApiStructure.nodes
        // Fields: id, displayName, type, detailsKey, statusKey
        graphApiStructureEditor.innerHTML = 'TODO: UI for graphApiStructure (for Netlify frontend)';
    }

    // Initial render
    renderAll();
});