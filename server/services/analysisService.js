import OpenAI from 'openai';

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY is not set. Analysis will fail.');
    return null;
  }
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

export async function analyzeDiscrepancy(suspectText, consensusText) {
  const openai = getOpenAIClient();
  if (!openai) {
    throw new Error('OpenAI API key is not configured.');
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Perform a Content Similarity Analysis. Compare Text A (Suspect) vs Text B (Consensus). Identify: 1. Factual Inconsistencies (Hallucinations). 2. Omissions of Context. 3. Bias. Return JSON: { "score": 0-100, "analysis": "string", "discrepancies": [{ "type": "Hallucination"|"Bias", "text": "string" }] }`,
        },
        {
          role: 'user',
          content: `Text A (Suspect):\\n${suspectText}\\n\\nText B (Consensus):\\n${consensusText}`,
        },
      ],
    });
    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error('Error analyzing discrepancy:', error);
    throw new Error('Failed to analyze discrepancy');
  }
}
