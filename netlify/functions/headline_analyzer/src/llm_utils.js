const fetch = require('node-fetch');

function extractAndParseJson(text) {
    // (Your existing robust extractAndParseJson function - unchanged)
    if (!text || typeof text !== 'string') {
        return null;
    }
    let cleanedText = text.replace(/^(?:json)?\s*```json\s*/, '').replace(/\s*```\s*$/, '').replace(/^(?:json)?\s*/, '').replace(/\s*$/, '').trim();
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

// Simple templating function (replace with Handlebars or similar if more complex logic is needed)
function renderTemplate(templateString, data) {
    let rendered = templateString;
    // Handle {{#each}}...{{/each}} blocks
    rendered = rendered.replace(/{{#(\w+)}}([\s\S]*?){{\/\1}}/g, (match, key, content) => {
        if (data[key] && Array.isArray(data[key])) {
            return data[key].map(item => renderTemplate(content, { ...data, ...item })).join('');
        }
        return '';
    });
    // Handle {{variable}} and {{{variable}}}
    for (const key in data) {
        if (data.hasOwnProperty(key)) {
            const value = data[key];
            // {{{variable}}} for unescaped HTML/JSON strings
            const unescapedRegex = new RegExp(`{{{${key}}}}`, 'g');
            rendered = rendered.replace(unescapedRegex, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
            // {{variable}} for regular values
            const escapedRegex = new RegExp(`{{${key}}}`, 'g');
            rendered = rendered.replace(escapedRegex, String(value));
        }
    }
    return rendered;
}


function prepareMessages(promptDefinition, state, graphConfig) {
    const templateData = {};

    // Map state values to template variables based on promptDefinition.input_mapping
    if (promptDefinition.input_mapping) {
        for (const templateVar in promptDefinition.input_mapping) {
            const stateKey = promptDefinition.input_mapping[templateVar];
            // Handle dot notation for nested state access, e.g., "analysis1_result.frames"
            let value = state;
            stateKey.split('.').forEach(part => {
                if (value && typeof value === 'object' && part in value) {
                    value = value[part];
                } else {
                    value = undefined; // Key not found
                }
            });
            templateData[templateVar] = value !== undefined ? value : ''; // Default to empty string if not found
        }
    }

    // Add JSON schema and examples to templateData
    templateData.json_schema = JSON.stringify(promptDefinition.json_schema, null, 2);
    templateData.examples = promptDefinition.examples || []; // Ensure examples is an array

    // Include all analysis results for synthesis prompt (special case for now)
    // This could be generalized if other prompts need many specific state parts
    if (promptDefinition.id.startsWith("SYNTHESIS")) {
        templateData.analysis1_result_json = JSON.stringify(state.analysis1_result || {error: "Not run"}, null, 2);
        templateData.analysis2_result_json = JSON.stringify(state.analysis2_result || {error: "Not run"}, null, 2);
        templateData.analysis3_result_json = JSON.stringify(state.analysis3_result || {error: "Not run"}, null, 2);
        templateData.analysis4_result_json = JSON.stringify(state.analysis4_result || {error: "Not run"}, null, 2);
        templateData.analysis5_result_json = JSON.stringify(state.analysis5_result || {error: "Not run"}, null, 2);
        templateData.agent1_had_error = !!(state.analysis1_result?.error);
        templateData.agent2_had_error = !!(state.analysis2_result?.error);
        templateData.agent3_had_error = !!(state.analysis3_result?.error);
        templateData.agent4_had_error = !!(state.analysis4_result?.error);
        templateData.agent5_had_error = !!(state.analysis5_result?.error);
    }


    return promptDefinition.messages_template.map(msgTmpl => ({
        role: msgTmpl.role === 'system' || msgTmpl.role === 'developer' ? 'user' : msgTmpl.role, // Gemini specific role mapping
        parts: [{ text: renderTemplate(msgTmpl.content, templateData) }]
    }));
}


async function callModel(promptDefinition, state, graphConfig, modelOverride = null) {
    if (!process.env.GEMINI_API_KEY) {
        return { error: 'Missing GEMINI_API_KEY', rawContent: '' };
    }
    const model = modelOverride || promptDefinition.model || 'gemini-1.5-flash-latest';
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const contents = prepareMessages(promptDefinition, state, graphConfig);

    const payload = {
        contents,
        generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 2048, // Consider making this configurable per prompt
            response_mime_type: "application/json"
        }
    };

    try {
        // console.log(`Calling model ${model} with payload:`, JSON.stringify(payload, null, 2)); // Verbose logging
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
            return parsedJson; // Successfully parsed JSON
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

module.exports = {
    extractAndParseJson,
    callModel,
    prepareMessages, // Export for testing/debugging if needed
    renderTemplate
};