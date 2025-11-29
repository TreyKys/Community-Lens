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

export const compareTexts = async (grokText, wikiText) => {
  if (!openai) {
    throw new Error("OPENAI_API_KEY is missing.");
  }

  const userPrompt = `Source A (Grok): "${grokText}"\n\nSource B (Wiki): "${wikiText}"`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "Compare Source A (Grok) vs Source B (Wiki). Return JSON with a 'score' (0-100) and specific 'discrepancies' (Hallucination, Omission, Bias)."
        },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
    });

    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    console.error("OpenAI Comparison Error:", error);
    throw new Error("Failed to compare sources.");
  }
};
