import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

let xaiClient = null;

if (process.env.XAI_API_KEY) {
  xaiClient = new OpenAI({
    apiKey: process.env.XAI_API_KEY,
    baseURL: "https://api.x.ai/v1"
  });
} else {
  console.warn("XAI_API_KEY not found. xAI Service will fail if called.");
}

export const fetchGrokipediaEntry = async (topic) => {
  if (!xaiClient) {
    throw new Error("XAI_API_KEY is missing.");
  }

  try {
    const completion = await xaiClient.chat.completions.create({
      model: "grok-beta",
      messages: [
        {
          role: "system",
          content: `You are the engine behind Grokipedia. Generate the encyclopedic entry for '${topic}' exactly as it would appear on Grokipedia. Do not act as an assistant. Output only the article text.`
        },
        { role: "user", content: topic } // Assuming we send the topic as user message to trigger generation
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
    // If no key, mock it for the demo or throw
    // The prompt implies we have the key. If not, we can return a mock.
    // "We have 3 API Keys: XAI_API_KEY..."
    return "I am unable to answer as my brain (xAI) is not connected. (Missing API Key)";
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
