import OpenAI from 'openai';
import dotenv from 'dotenv';
import caseStudies from '../data/caseStudies.js';

dotenv.config();

let openai = null;

if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
} else {
    console.warn("OPENAI_API_KEY not found. Using AI simulation/fallback mode.");
}

export const analyzeText = async (grokText, wikiText, topic) => {
  // 1. Check for pre-calculated case study match (Fallback/Demo Optimization)
  const foundStudy = caseStudies.find(study =>
    study.grokText === grokText || study.topic === topic
  );

  if (!process.env.OPENAI_API_KEY || process.env.AI_PROVIDER === 'mock') {
    console.log(`Using Mock Analysis for topic: ${topic}`);
    if (foundStudy) {
      return foundStudy.preCalculatedAnalysis;
    }
    // Generic mock if no specific case study matches
    return {
      alignmentScore: 50,
      flags: [{ type: "Simulation", text: "No AI Key", explanation: "Using mock analysis due to missing API Key." }]
    };
  }

  // 2. Real OpenAI Analysis
  try {
    const prompt = `
      Compare the following two texts about "${topic}".
      Text 1 (Suspect Source): "${grokText}"
      Text 2 (Trusted Source): "${wikiText}"

      Identify discrepancies, factual errors, or hallucinations in Text 1 based on Text 2.
      Return a JSON object with:
      - alignmentScore (0-100 integer)
      - flags: an array of objects { type: "Hallucination"|"Omission"|"Bias", text: "excerpt from Text 1", explanation: "why it is wrong" }

      Return ONLY raw JSON.
    `;

    const completion = await openai.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(completion.choices[0].message.content);
    return result;
  } catch (error) {
    console.error("OpenAI Analysis Failed:", error);
    // Fallback to pre-calculated if AI fails
    if (foundStudy) return foundStudy.preCalculatedAnalysis;
    throw error;
  }
};
