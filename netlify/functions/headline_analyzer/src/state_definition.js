/**
 * @typedef {object} AppState
 * @property {string} [input_headline] - The original headline provided by the user.
 * @property {string} [headlineToAnalyze] - The headline version (original or placeholderized) passed to the analyzer nodes.
 * @property {string} [headline_with_placeholders] - The headline after initial proper noun replacement (from properNoun_replacer1).
 * @property {object} [properNoun_map] - Mapping of placeholders to original proper nouns.
 *
 * // Raw results from each node/agent
 * @property {object | {error: string, rawContent?: string}} [properNoun_replacement1_result] - Full result from the initial proper noun replacer.
 *
 * // Analysis results from parallel_analyzers_coordinator
 * @property {object | {error: string, rawContent?: string}} [cognitive_frames_analysis_result]
 * @property {object | {error: string, rawContent?: string}} [speculative_reframing_result]
 * @property {object | {error: string, rawContent?: string}} [euphemism_analysis_result]
 * @property {object | {error: string, rawContent?: string}} [episodic_thematic_analysis_result]
 * @property {object | {error: string, rawContent?: string}} [violence_type_analysis_result]
 *
 * // Reverted headlines from individual analyzers and their reverter details
 * @property {string} [speculative_reverted_headline] - Final reverted headline from the speculative rephrasing analyzer.
 * @property {object} [speculative_reverter_details] - Details from the speculative_reverter node.
 *
 * @property {string} [episodic_thematic_reverted_headline] - Final reverted headline from the episodic_thematic analyzer.
 * @property {object} [episodic_thematic_reverter_details] - Details from the episodic_thematic_reverter node.
 *
 * @property {string} [violence_type_reverted_headline] - Final reverted headline from the violence type analyzer.
 * @property {object} [violence_type_reverter_details] - Details from the violence_type_reverter node.
 * 
 * @property {string} [euphemism_reverted_headline] - Final reverted headline from the violence type analyzer.
 * @property {object} [euphemism_reverter_details] - Details from the violence_type_reverter node.

 * @property {string} [cognitive_frames_reverted_headline] - Final reverted headline from the violence type analyzer.
 * @property {object} [cognitive_frames_reverter_details] - Details from the violence_type_reverter node.
 * // Add more here if other analyzers produce revertable headlines and have their own reverters
 *
 * // Synthesis result and its reverted version
 * @property {object | {error: string, rawContent?: string}} [synthesis_result] - Full result from the main synthesizer node.
 * @property {string} [main_flipped_headline_with_placeholders] - The primary "flipped" headline from synthesizer (may contain placeholders).
 * @property {string} [flipped_headline] - The final, reverted main "flipped" headline (after main_headline_reverter).
 * @property {object} [properNoun_replacement2_details] - Details from the main_headline_reverter node (for the synthesized headline).
 *
 * // Save status
 * @property {{success: boolean, message?: string, headline_id?: string, saved_item_keys?: string[]}} [db_save_status] - Status of the save operation to DynamoDB.
 *
 * // Error accumulation
 * @property {string[]} [error_messages] - Accumulates error messages from various nodes during graph execution.
 */

// These channels define how state keys are updated in the LangGraph StateGraph.
// (x, y) => y means the new value (y) overwrites the old one (x).
// default: () => undefined means the key will be undefined if not set.
const appStateChannels = {
    input_headline: { value: (x, y) => y, default: () => undefined },
    headlineToAnalyze: { value: (x, y) => y, default: () => undefined },
    headline_with_placeholders: { value: (x, y) => y, default: () => undefined },
    properNoun_map: { value: (x, y) => y, default: () => ({}) },

    // Raw node results
    properNoun_replacement1_result: { value: (x, y) => y, default: () => undefined },
    cognitive_frames_analysis_result: { value: (x, y) => y, default: () => undefined },
    speculative_reframing_result: { value: (x, y) => y, default: () => undefined },
    euphemism_analysis_result: { value: (x, y) => y, default: () => undefined },
    episodic_thematic_analysis_result: { value: (x, y) => y, default: () => undefined },
    violence_type_analysis_result: { value: (x, y) => y, default: () => undefined },
    synthesis_result: { value: (x, y) => y, default: () => undefined },

    // Placeholderized headline from synthesizer
    main_flipped_headline_with_placeholders: { value: (x, y) => y, default: () => undefined },

    // Final reverted headlines
    flipped_headline: { value: (x, y) => y, default: () => undefined }, // Main one from synthesizer path
    speculative_reverted_headline: { value: (x, y) => y, default: () => undefined },
    episodic_thematic_reverted_headline: { value: (x, y) => y, default: () => undefined },
    violence_type_reverted_headline: { value: (x, y) => y, default: () => undefined },
    cognitive_frames_reverted_headline: { value: (x, y) => y, default: () => undefined },
    euphemism_reverted_headline: { value: (x, y) => y, default: () => undefined },
    // Add more channels for other reverted analyzer headlines if needed

    // Details from reverter nodes
    properNoun_replacement2_details: { value: (x, y) => y, default: () => undefined }, // For main_headline_reverter
    speculative_reverter_details: { value: (x, y) => y, default: () => undefined },
    episodic_thematic_reverter_details: { value: (x, y) => y, default: () => undefined },
    violence_type_reverter_details: { value: (x, y) => y, default: () => undefined },
    cognitive_frames_reverter_details: { value: (x, y) => y, default: () => undefined },
    euphemism_reverter_details: { value: (x, y) => y, default: () => undefined },
    // Add more channels for other reverter details if needed

    // DB status and errors
    db_save_status: { value: (x, y) => y, default: () => undefined },
    error_messages: { value: (x, y) => (x || []).concat(y), default: () => [] }, // Append new errors

    data_package_for_saver: { value: (x, y) => y, default: () => undefined }, // New
    db_save_status: { value: (x, y) => y, default: () => undefined },
};

module.exports = {
  // AppState typedef is for JSDoc/documentation purposes.
  appStateChannels,
};