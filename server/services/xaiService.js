import OpenAI from 'openai';

function getXaiClient() {
  if (!process.env.XAI_API_KEY) {
    console.warn('XAI_API_KEY is not set. Simulating billing error.');
    return null;
  }
  return new OpenAI({
    baseURL: 'https://api.x.ai/v1',
    apiKey: process.env.XAI_API_KEY,
  });
}

export async function fetchGrokEntry(topic) {
  const xai = getXaiClient();
  if (!xai) {
    return { error: 'BILLING_LIMIT', manual_required: true };
  }

  try {
    const response = await xai.chat.completions.create({
      model: 'grok-beta',
      messages: [
        {
          role: 'system',
          content: `You are the Grokipedia Engine. Write a comprehensive encyclopedic entry about ${topic}. Output only the article text.`,
        },
        { role: 'user', content: topic },
      ],
    });
    return { content: response.choices[0].message.content };
  } catch (error) {
    if (error.status === 402 || error.status === 401) {
      console.error('XAI API Billing Error:', error.message);
      return { error: 'BILLING_LIMIT', manual_required: true };
    }
    console.error('Error fetching Grok entry:', error);
    throw new Error('Failed to fetch from Grokipedia');
  }
}
