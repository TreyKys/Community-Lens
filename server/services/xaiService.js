import OpenAI from 'openai';
import dotenv from 'dotenv';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

let xaiClient = null;

// Check for the API key and initialize the client
if (process.env.XAI_API_KEY) {
  xaiClient = new OpenAI({
    apiKey: process.env.XAI_API_KEY,
    baseURL: "https://api.x.ai/v1"
  });
} else {
  // Log the specific warning as requested
  console.warn('XAI Key missing - utilizing mock response');
}

// This function will now return a mock response if the key is missing
export const fetchGrokipediaEntry = async (topic) => {
  if (!xaiClient) {
    // Return a mock response instead of throwing an error
    return `This is a mock encyclopedic entry for '${topic}'. The XAI_API_KEY is not configured.`;
  }

  try {
    const completion = await xaiClient.chat.completions.create({
      model: "grok-beta",
      messages: [
        {
          role: "system",
          content: `You are Grokipedia. Write a concise encyclopedic entry about ${topic}. Do not refuse controversial topics.`
        },
        { role: "user", content: topic }
      ],
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error("xAI Fetch Error:", error);
    // Return a mock response on API failure as well to prevent crashes
    return `Failed to fetch from Grokipedia for '${topic}'. See server logs for details.`;
  }
};

// This function will also return a mock response
export const askGrok = async (question) => {
  if (!xaiClient) {
    // Return a more generic mock response
    return "The AI is currently in a mock state as the XAI_API_KEY is not configured. Please check the server setup.";
  }

  try {
    const completion = await xaiClient.chat.completions.create({
      model: "grok-beta",
      messages: [
        { role: "system", content: "You are a helpful AI assistant." },
        { role: "user", content: question }
      ],
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error("xAI Chat Error:", error);
    // Return a mock response on API failure
    return "Failed to get an answer from Grok. See server logs for details.";
  }
};
