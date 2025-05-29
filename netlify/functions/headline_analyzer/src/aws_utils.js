const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

let docClient;

function getDocClient() {
    if (!docClient) {
        AWS.config.update({
            accessKeyId: process.env.ACCESS_KEY_ID,
            secretAccessKey: process.env.SECRET_ACCESS_KEY,
            region: process.env.REGION,
        });
        docClient = new AWS.DynamoDB.DocumentClient();
    }
    return docClient;
}

async function saveHeadlineData({ input_headline, flipped_headline, human_flipped_headline = '' }) {
    const client = getDocClient();
    const params = {
        TableName: 'NewsFrames', // Consider making this configurable if needed
        Item: {
            headline_id: uuidv4(),
            input_headline,
            flipped_headline,
            human_flipped_headline,
            created_at: new Date().toISOString(),
        },
    };
    try {
        await client.put(params).promise();
        return { success: true };
    } catch (error) {
        console.error('Error saving to DynamoDB:', error);
        return { success: false, message: 'Database error: ' + error.message };
    }
}

module.exports = {
    saveHeadlineData,
};