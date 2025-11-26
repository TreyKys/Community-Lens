import OpenAI from 'openai';
import dotenv from 'dotenv';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

let openai = null;

if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
} else {
  console.warn("OPENAI_API_KEY not found. Analysis Service will fail if called.");
}

export const analyzeDiscrepancy = async (suspectText, consensusText, mode) => {
  if (!openai) {
    throw new Error("OPENAI_API_KEY is missing.");
  }

  const systemPrompt = `
    Perform a Content Similarity Analysis. Compare Text A (Suspect) vs Text B (Consensus).
    Identify: 1. Factual Inconsistencies (Hallucinations). 2. Omissions of Context. 3. Bias.
    Rule: If the analysis 'mode' is 'medical', prioritize PubMed data from the Consensus Text for any clinical efficacy claims.
    Return JSON: { score: 0-100, analysis: string, discrepancies: [{ type: 'Hallucination'|'Bias', text: string }] }.
  `;

  const userPrompt = `Mode: ${mode || 'general'}\n\nText A (Suspect): "${suspectText}"\n\nText B (Consensus): "${consensusText}"`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4", // Or gpt-3.5-turbo if preferred
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
    });

    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    console.error("OpenAI Analysis Error:", error);
    throw new Error("Failed to analyze sources.");
  }
};
