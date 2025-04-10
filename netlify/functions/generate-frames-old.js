const fetch = require('node-fetch');

exports.handler = async function(event, context) {
  try {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method Not Allowed' })
      };
    }

    // Parse the incoming request body
    const { headline } = JSON.parse(event.body);
    
    if (!headline) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Headline is required' })
      };
    }

    
    // The system prompt for Gemini
    const systemPrompt = `You are an expert in media framing analysis. Your task is to take a news headline and generate 5 different ways it could be framed by different news sources with varying perspectives and biases. You should NOT label the frames by political leaning or specific news outlets.

Instead, label each frame with a descriptive title that indicates the focus or perspective (e.g., "Economic Impact Focus", "Human Interest Angle", "Historical Context Frame", "Global Perspective", "Conflict-Centered").

For each frame:
1. Provide a rewritten headline that demonstrates that particular framing
2. Keep the core facts the same, but change emphasis, word choice, and perspective
3. Make the differences subtle but noticeable

Format each frame as:
[Frame Title]: [Rewritten Headline]

Return ONLY the frames without additional commentary, explanation, or preamble.`;

    // Get the Gemini API key from the environment variable
    const API_KEY = process.env.GEMINI_API_KEY;
    const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
    
    const requestBody = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: systemPrompt + "\n\nHeadline: " + headline
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024
      }
    };
    
    const response = await fetch(`${API_URL}?key=${API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error("API Error:", errorText);
      throw new Error(`API request failed with status ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    
    // Handle the response format correctly
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0].text) {
      console.error("Unexpected API response format:", JSON.stringify(data));
      throw new Error("Unexpected API response format");
    }
    
    const text = data.candidates[0].content.parts[0].text;
    
    // Parse the frames from the response
    const lines = text.split('\n').filter(line => line.trim() !== '');
    const frames = [];
    
    lines.forEach(line => {
      const match = line.match(/^(.+?):\s(.+)$/);
      if (match) {
        frames.push({
          title: match[1].trim(),
          headline: match[2].trim()
        });
      }
    });
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', // For local testing
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify({ frames })
    };
    
  } catch (error) {
    console.error('Error:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', // For local testing
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify({ 
        error: 'Internal Server Error', 
        message: error.message 
      })
    };
  }
};