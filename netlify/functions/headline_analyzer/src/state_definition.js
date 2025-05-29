// This file defines the AppState structure.
// It should correspond to the keys defined in graph_config.json's appStateChannels.

/**
 * @typedef {object} AppState
 * @property {string} [input_headline]
 * @property {string} [headline_with_placeholders]
 * @property {object} [properNoun_map]
 * @property {object | {error: string, rawContent?: string}} [properNoun_replacement1_result]
 * @property {object | {error: string, rawContent?: string}} [analysis1_result]
 * @property {object | {error: string, rawContent?: string}} [analysis2_result]
 * @property {object | {error: string, rawContent?: string}} [analysis3_result]
 * @property {object | {error: string, rawContent?: string}} [analysis4_result]
 * @property {object | {error: string, rawContent?: string}} [analysis5_result]
 * @property {object | {error: string, rawContent?: string}} [synthesis_result]
 * @property {string} [flipped_headline_with_placeholders]
 * @property {string} [flipped_headline]
 * @property {object} [properNoun_replacement2_details]
 * @property {{success: boolean, message?: string}} [db_save_status]
 * @property {string} [error_message]
 * // Add any new state keys that new nodes might introduce
 */

// Helper to parse channel functions from string (EVAL IS DANGEROUS - USE WITH CAUTION)
// In a production system, you'd want a safer way if these come from untrusted sources.
// Since graph_config.json is edited by your trusted UI, it's less of a risk here.
function parseChannelFunction(fnString) {
    if (typeof fnString !== 'string') return fnString; // Already a function
    try {
        // Sanitize slightly: allow only simple function definitions
        if (!fnString.match(/^(\(.*?\)|[\w_]+)\s*=>\s*.*$/) && !fnString.match(/^function\s*\(.*?\)\s*\{.*\}$/)) {
            console.warn("Potentially unsafe function string in appStateChannels:", fnString);
            // Fallback to a simple y => y or similar if concerned
            return (x,y) => y;
        }
        return eval(fnString);
    } catch (e) {
        console.error("Error parsing channel function string:", fnString, e);
        return (x, y) => y; // Default reducer
    }
}

function getAppStateChannels(configChannels) {
    const channels = {};
    for (const key in configChannels) {
        channels[key] = {
            value: parseChannelFunction(configChannels[key].value),
            default: configChannels[key].default ? parseChannelFunction(configChannels[key].default) : undefined
        };
    }
    return channels;
}


module.exports = {
    getAppStateChannels
    // AppState typedef is for JSDoc, not directly used by LangGraph runtime here
};