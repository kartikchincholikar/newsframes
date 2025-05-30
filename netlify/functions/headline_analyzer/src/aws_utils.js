// src/aws_utils.js
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

let docClient;

function getDocClient() {
    if (!docClient) {
        // Ensure environment variables are loaded, especially if this module is imported early
        // and .env hasn't been processed by a higher-level framework like Netlify's build.
        // For local development, ensure you're using something like `dotenv` or that they are globally set.
        if (!process.env.ACCESS_KEY_ID || !process.env.SECRET_ACCESS_KEY || !process.env.REGION) {
            console.warn(
                "AWS credentials or region not fully set in environment variables. " +
                "DynamoDB operations might fail. Ensure ACCESS_KEY_ID, SECRET_ACCESS_KEY, and REGION are set."
            );
        }
        AWS.config.update({
            accessKeyId: process.env.ACCESS_KEY_ID,
            secretAccessKey: process.env.SECRET_ACCESS_KEY,
            region: process.env.REGION,
        });
        docClient = new AWS.DynamoDB.DocumentClient();
    }
    return docClient;
}

/**cognitive_frames_reverted_headline euphemism_reverted_headline
 * Saves various headline data to DynamoDB.
 * @param {object} dataToSave - An object containing all data to be saved.
 * @param {string} dataToSave.input_headline - The original input headline.
 * @param {string} [dataToSave.main_flipped_headline] - The primary flipped headline from the synthesizer.
 * @param {string} [dataToSave.speculative_reverted_headline] - Reverted headline from speculative analyzer.
 * @param {string} [dataToSave.framing_type_reverted_headline] - Reverted headline from framing type analyzer.
 * @param {string} [dataToSave.violence_type_reverted_headline] - Reverted headline from violence type analyzer.
 * @param {string} [dataToSave.cognitive_frames_reverted_headline] - Reverted headline from framing type analyzer.
 * @param {string} [dataToSave.euphemism_reverted_headline] - Reverted headline from violence type analyzer.
 * @param {string} [dataToSave.human_flipped_headline=''] - Manually provided flipped headline.
 * @param {object} [dataToSave.raw_analysis_results] - Optional object to store raw results from analyzers.
 *                                                    e.g., { cognitive_frames: ..., speculative_reframing: ... }
 * @returns {Promise<{success: boolean, message?: string, headline_id?: string, saved_item_keys?: string[]}>}
 */
async function saveHeadlineData(dataToSave) {
    const client = getDocClient();
    const tableName = 'NewsFrames'; // Consider making this configurable if needed, e.g., via process.env.DYNAMODB_TABLE_NAME

    if (!dataToSave || !dataToSave.input_headline) {
        console.error('Error saving to DynamoDB: input_headline is required.');
        return { success: false, message: 'Database error: input_headline is required.' };
    }

    const headline_id = uuidv4();
    const itemToSave = {
        headline_id,
        input_headline: dataToSave.input_headline,
        created_at: new Date().toISOString(),
    };

    const dbAttributeMapping = {
        "input_headline": "input_headline",
        "main_flipped_headline_from_state": "flipped_headline", 
        "speculative_reverted_headline": "speculative_reverted_headline_db", // Example: if DB attr name is different
        "framing_type_reverted_headline": "framing_type_reverted_headline_db",
        "violence_type_reverted_headline": "violence_type_reverted_headline_db",
        "cognitive_frames_reverted_headline_to_save": "cognitive_frames_reverted_db",
        "euphemism_reverted_headline_to_save": "euphemism_reverted_db",
        "human_flipped_headline": "human_flipped_headline",
        "raw_cognitive_frames_analysis_result": "raw_cognitive_frames_data",
        "raw_euphemism_analysis_result": "raw_euphemism_data"
    };

    for (const dataKey in dbAttributeMapping) {
        if (dataToSave.hasOwnProperty(dataKey)) {
            const dbAttribute = dbAttributeMapping[dataKey];
            const value = dataToSave[dataKey];
            // More generic value handling
            if (value !== undefined && value !== null) {
            if (typeof value === 'string' && value.trim() === '' && dataKey !== 'human_flipped_headline') {
                // Skip saving empty strings for most fields, unless it's human_flipped_headline
            } else {
                itemToSave[dbAttribute] = value; // This will save objects as Maps
            }
            }
        }
    }

    // Conditionally add fields if they exist and are strings (or objects for raw results)
    // This prevents adding 'undefined' or 'null' fields to DynamoDB unless intended.
    // const fieldsToPotentiallySave = [
    //     'main_flipped_headline',
    //     'speculative_reverted_headline',
    //     'framing_type_reverted_headline',
    //     'violence_type_reverted_headline',
    //     // Add more keys for other reverted headlines here as they are defined in graph_config.json and state_definition.js
    //     'human_flipped_headline',
    // ];

    // Default human_flipped_headline if not provided or empty after checks
    if (!itemToSave.hasOwnProperty('human_flipped_headline')) {
        itemToSave.human_flipped_headline = '';
    }

    // fieldsToPotentiallySave.forEach(key => {
    //     if (dataToSave.hasOwnProperty(key) && typeof dataToSave[key] === 'string' && dataToSave[key].trim() !== '') {
    //         itemToSave[key] = dataToSave[key];
    //     } else if (dataToSave.hasOwnProperty(key) && dataToSave[key] === '') { // Handle explicitly empty string if desired
    //          itemToSave[key] = ''; // Or you might choose to omit empty strings
    //     }
    // });
    
    // // Default human_flipped_headline if not provided or empty after checks
    // if (!itemToSave.hasOwnProperty('human_flipped_headline')) {
    //     itemToSave.human_flipped_headline = '';
    // }


    // Example: Saving raw analysis results if provided
    // Your UI/graph config would need to ensure 'raw_analysis_results' is populated in dataToSave
    if (dataToSave.raw_analysis_results && typeof dataToSave.raw_analysis_results === 'object') {
        itemToSave.raw_analysis_data = dataToSave.raw_analysis_results; // Storing as a map
    }

    const params = {
        TableName: tableName,
        Item: itemToSave,
    };

    try {
        await client.put(params).promise();
        console.log(`Data saved to DynamoDB (Table: ${tableName}, ID: ${headline_id})`);
        return {
            success: true,
            headline_id: headline_id,
            saved_item_keys: Object.keys(itemToSave) // Useful for diagnostics
        };
    } catch (error) {
        console.error('Error saving to DynamoDB:', error);
        return { success: false, message: 'Database error: ' + error.message, details: error.stack };
    }
}

module.exports = {
    saveHeadlineData,
    getDocClient, // Exporting this might be useful for other AWS operations if needed elsewhere
};