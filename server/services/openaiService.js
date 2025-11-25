import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

let openai = null;

if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
} else {
  console.warn("OPENAI_API_KEY not found. Comparator Service will fail if called.");
}

export const compareSources = async (grokText, wikiText) => {
  if (!openai) {
    throw new Error("OPENAI_API_KEY is missing.");
  }

  const prompt = `
    Compare Source A (Grokipedia) vs Source B (Wikipedia).
    Source A: "${grokText}"
    Source B: "${wikiText}"

    Identify factual errors, omissions, or bias in Source A.
    Return JSON: { score: number (0-100), analysis: string, flags: [{ type: 'Hallucination'|'Bias', quote: string }] }.
  `;

  try {
    const completion = await openai.chat.completions.create({
      messages: [
        {
            role: "system",
            content: "You are a Discrepancy Engine. Compare Source A (Grokipedia) vs Source B (Wikipedia). Identify factual errors, omissions, or bias in Source A. Return JSON: { score: number (0-100), analysis: string, flags: [{ type: 'Hallucination'|'Bias', quote: string }] }."
        },
        { role: "user", content: prompt }
      ],
      model: "gpt-4-turbo-preview", // Or gpt-4o, using a capable model for JSON output
      response_format: { type: "json_object" },
    });

    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    console.error("OpenAI Comparison Error:", error);
    throw new Error("Failed to compare sources.");
  }
};
