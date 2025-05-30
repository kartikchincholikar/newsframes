// src/llm_utils.js
const fetch = require('node-fetch');

function extractAndParseJson(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }
    // Simplified cleaning - assumes Gemini's JSON output is mostly clean
    let cleanedText = text.trim();
    if (cleanedText.startsWith("```json")) {
        cleanedText = cleanedText.substring(7);
    } else if (cleanedText.startsWith("```")) {
        cleanedText = cleanedText.substring(3);
    }
    if (cleanedText.endsWith("```")) {
        cleanedText = cleanedText.substring(0, cleanedText.length - 3);
    }
    cleanedText = cleanedText.trim();

    const firstBrace = cleanedText.indexOf('{');
    const lastBrace = cleanedText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const potentialJson = cleanedText.substring(firstBrace, lastBrace + 1);
        try {
            return JSON.parse(potentialJson);
        } catch (e) {
            console.warn('JSON parse failed after substring extraction:', e.message, 'Extracted Substring:', potentialJson.substring(0, 200));
            // Fallback: try parsing the cleanedText directly
            try {
                return JSON.parse(cleanedText);
            } catch (e2) {
                console.warn('JSON parse failed on cleanedText:', e2.message, 'Cleaned Text:', cleanedText.substring(0,200));
                return null;
            }
        }
    } else {
         try {
            return JSON.parse(cleanedText);
        } catch (e3) {
            console.warn('JSON parse failed on original cleanedText (no/invalid braces):', e3.message, 'Cleaned Text:', cleanedText.substring(0,200));
            return null;
        }
    }
}


function renderTemplate(templateString, data) {
    if (typeof templateString !== 'string') {
        console.warn("renderTemplate: templateString is not a string", templateString);
        return ""; // Return empty string for invalid templates
    }
    let rendered = templateString;
    // Simpler {{variable}} replacement. Your existing one is more complex.
    // This basic one assumes data keys don't contain regex special characters.
    for (const key in data) {
        if (data.hasOwnProperty(key)) {
            const value = data[key];
            // Ensure value is stringifiable for the template
            const stringValue = (typeof value === 'object' && value !== null) ? JSON.stringify(value, null, 2) : String(value);
            const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
            rendered = rendered.replace(regex, stringValue);
        }
    }
    return rendered;
}

// This function now takes the 'promptConfig' from graph_config.json's nodeDefinition
// and the current 'state'. It constructs the messages array.
function buildMessagesFromPromptConfig(promptConfig, state, nodeSpecificArgs = {}) {
    if (!promptConfig || !promptConfig.systemMessage || !promptConfig.userInputTemplate) {
        console.error("buildMessagesFromPromptConfig: promptConfig is incomplete.", promptConfig);
        return [{ role: 'user', parts: [{ text: "Error: Prompt configuration is incomplete." }] }]; // Return error message
    }

    const templateData = { ...state, ...nodeSpecificArgs }; // Combine state with any specific args for this node

    const messages = [];

    if (promptConfig.systemMessage) {
        messages.push({
            role: 'system', // This will be mapped to 'user' for Gemini later
            content: renderTemplate(promptConfig.systemMessage, templateData)
        });
    }
    if (promptConfig.developerInstructionsTemplate) {
        messages.push({
            role: 'developer', // Mapped to 'user'
            content: renderTemplate(promptConfig.developerInstructionsTemplate, templateData)
        });
    }
    if (promptConfig.userInputTemplate) {
        messages.push({
            role: 'user',
            content: renderTemplate(promptConfig.userInputTemplate, templateData)
        });
    }
    return messages;
}


// This function adapts message roles for the Gemini API
function mapMessagesForGemini(messagesFromBuilder) {
    if (!Array.isArray(messagesFromBuilder)) {
        console.error("mapMessagesForGemini: input is not an array", messagesFromBuilder);
        return [{ role: 'user', parts: [{ text: "Error: Invalid message array." }] }];
    }

    return messagesFromBuilder.map(msg => {
        if (!msg || typeof msg.role !== 'string' || typeof msg.content !== 'string') {
            console.warn("mapMessagesForGemini: Invalid message structure:", msg);
            return { role: 'user', parts: [{ text: `Error: Malformed message. Role: ${msg?.role}` }] };
        }

        let geminiRole = 'user'; // Default
        const roleLower = msg.role.toLowerCase();

        if (roleLower.startsWith('system') || roleLower.startsWith('developer')) {
            geminiRole = 'user';
        } else if (roleLower.startsWith('assistant') || roleLower.startsWith('ai') || roleLower.startsWith('model')) {
            geminiRole = 'model';
        } else if (roleLower === 'user') {
            geminiRole = 'user';
        }
        // else, it's 'user' by default. Could add a warning for unknown roles.

        return {
            role: geminiRole,
            parts: [{ text: msg.content }]
        };
    });
}


async function callModel(
    messages, // This will be the array from buildMessagesFromPromptConfig
    modelName = 'gemini-1.5-flash-latest', // modelName from promptConfig or default
    generationArgs = {} // temperature, maxOutputTokens from promptConfig or defaults
) {
    if (!process.env.GEMINI_API_KEY) {
        return { error: 'Missing GEMINI_API_KEY', rawContent: '' };
    }
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

    const geminiContents = mapMessagesForGemini(messages);

    // Check if mapping introduced errors
    if (geminiContents.some(c => c.parts[0].text.startsWith("Error:"))) {
        console.error("callModel: Error during message role mapping for Gemini.", geminiContents);
        return { error: "Internal error: Malformed message structure for LLM after role mapping.", rawContent: JSON.stringify(geminiContents) };
    }

    const payload = {
        contents: geminiContents,
        generationConfig: {
            temperature: generationArgs.temperature || 0.3,
            maxOutputTokens: generationArgs.maxOutputTokens || 2048,
            response_mime_type: "application/json"
        }
    };
    // console.log(`[LLM_UTILS] Calling ${modelName} with payload:`, JSON.stringify(payload, null, 2).substring(0,500));

    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
            body: JSON.stringify(payload)
        });

        const responseBodyText = await res.text(); // Get text first for better error details

        if (!res.ok) {
            console.error(`Model API error: ${res.status}. Response body: ${responseBodyText.substring(0, 500)}`);
            let errorDetail = responseBodyText.substring(0, 200);
            try {
                const errorJson = JSON.parse(responseBodyText); // Try to parse if it's JSON error
                errorDetail = JSON.stringify(errorJson.error || errorJson);
            } catch (e) { /* already have text */ }
            return { error: `Model API error: ${res.status}. Details: ${errorDetail}`, rawContent: responseBodyText };
        }

        const responseJson = JSON.parse(responseBodyText); // Parse if res.ok
        const rawContent = responseJson?.candidates?.[0]?.content?.parts?.[0]?.text;
        const finishReason = responseJson?.candidates?.[0]?.finishReason;

        if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
             console.warn(`Gemini generation for ${modelName} finished with reason: ${finishReason}.`);
             let errMessage = `Content generation stopped due to: ${finishReason}.`;
             if (finishReason === "SAFETY") errMessage = "Content generation stopped due to safety settings.";
             else if (finishReason === "RECITATION") errMessage = "Content generation stopped due to recitation policy.";
             return { error: errMessage, rawContent: rawContent || `Blocked by ${finishReason}.`, fullResponse: responseJson };
        }

        if (typeof rawContent !== 'string' || rawContent.trim() === '') {
            console.warn('Received empty or non-string content from model:', responseJson);
            return { error: "Model returned empty or invalid content", rawContent: rawContent || '', fullResponse: responseJson };
        }

        const parsedJson = extractAndParseJson(rawContent); // Use your robust parser
        if (parsedJson !== null) {
            return parsedJson;
        } else {
            console.error('Failed to parse JSON from model response. Raw content:', rawContent.substring(0, 500));
            return { error: "Failed to parse JSON response from model", rawContent: rawContent };
        }
    } catch (error) {
        console.error('Error calling model or processing response:', error);
        return { error: `Network or unexpected error in callModel: ${error.message}`, rawContent: '' };
    }
}

module.exports = {
    extractAndParseJson, // Keep your robust one
    callModel,
    buildMessagesFromPromptConfig, // New helper
    renderTemplate // Keep your template renderer
};