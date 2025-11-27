const axios = require('axios');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_ENDPOINT = process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta2';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/text-bison-001';
const TIMEOUT = 20000;

async function callGeminiRaw(promptText) {
  if (!GEMINI_API_KEY) {
    // no key: return simulated
    return { text: `SIMULATED ANSWER (no GEMINI API key). Prompt: ${promptText.slice(0,200)}` };
  }
  const url = `${GEMINI_ENDPOINT}/models/${encodeURIComponent(GEMINI_MODEL)}:generateText`;
  const payload = {
    prompt: { text: promptText },
    maxOutputTokens: 700,
    temperature: 0.0
  };
  const headers = {
    Authorization: `Bearer ${GEMINI_API_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    const resp = await axios.post(url, payload, { headers, timeout: TIMEOUT });
    // Extract textual content from response robustly
    const data = resp.data;
    if (Array.isArray(data?.candidates) && data.candidates[0]?.output) {
      return { text: String(data.candidates[0].output) };
    }
    // Handle newer Gemini API response structures if different
    if (data?.candidates && data.candidates[0]?.content && data.candidates[0].content.parts) {
         return { text: data.candidates[0].content.parts.map(p => p.text).join('') };
    }
    // Fallback for text-bison legacy
    if (Array.isArray(data?.candidates) && data.candidates[0]?.content) {
       return { text: String(data.candidates[0].content) };
    }

    return { text: JSON.stringify(data) };
  } catch (error) {
    console.error("Gemini API call failed", error.response?.data || error.message);
    return { text: "Error calling Gemini API" };
  }
}

async function answerQuestionWithGemini({ question, topic='' }) {
  const system = `You are an accurate, concise assistant. Answer in plain text. If the question is uncertain, say so and cite why.`;
  const prompt = `${system}\n\nTopic: ${topic}\nQuestion: ${question}\n\nAnswer:`;
  const r = await callGeminiRaw(prompt);
  return r.text;
}

module.exports = { callGeminiRaw, answerQuestionWithGemini };
