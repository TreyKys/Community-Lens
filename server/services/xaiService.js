import OpenAI from 'openai';
import dotenv from 'dotenv';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

// Try both XAI_API_KEY and XAPI_API_KEY
const apiKey = process.env.XAI_API_KEY || process.env.XAPI_API_KEY;

let xaiClient = null;
if (apiKey) {
  xaiClient = new OpenAI({
    apiKey: apiKey,
    baseURL: "https://api.x.ai/v1"
  });
} else {
  console.warn("XAI_API_KEY or XAPI_API_KEY not found. xAI Service will fail if called.");
}

export const fetchGrokEntry = async (topic) => {
  if (!xaiClient) {
    // Simulate billing error for manual mode testing if no key is present
    return { error: "BILLING_LIMIT", manual_required: true };
  }

  try {
    const completion = await xaiClient.chat.completions.create({
      model: "grok-beta", // Assuming this is the correct model name for Grokipedia
      messages: [
        {
          role: "system",
          content: "You are the Grokipedia Engine. Write a comprehensive encyclopedic entry about the given topic. Output only the article text."
        },
        { role: "user", content: topic }
      ],
    });

    return { grokText: completion.choices[0].message.content };
  } catch (error) {
    // Check for 401/402 billing errors
    if (error.status === 401 || error.status === 402) {
      console.error("xAI Billing Error:", error.message);
      return { error: "BILLING_LIMIT", manual_required: true };
    }
    console.error("xAI Fetch Error:", error);
    throw new Error("Failed to fetch from Grokipedia.");
  }
};

export const askGrok = async (question) => {
  if (!xaiClient) {
    return "The xAI client is not initialized. Please check your API keys.";
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
