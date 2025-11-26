import OpenAI from 'openai';
import dotenv from 'dotenv';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

let xaiClient = null;

if (process.env.XAPI_API_KEY) {
  xaiClient = new OpenAI({
    apiKey: process.env.XAPI_API_KEY,
    baseURL: "https://api.x.ai/v1"
  });
} else {
  console.warn("XAPI_API_KEY not found. xAI Service will fail if called.");
}

export const fetchGrokipediaEntry = async (topic) => {
  if (!xaiClient) {
    // Restore strict error handling
    throw new Error("XAPI client not initialized. Check for missing API key.");
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
    throw new Error("Failed to fetch from Grokipedia.");
  }
};

export const askGrok = async (question) => {
  if (!xaiClient) {
    // Restore strict error handling
    throw new Error("XAPI client not initialized. Check for missing API key.");
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
    throw new Error("Failed to get answer from Grok.");
  }
};
