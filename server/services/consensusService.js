import axios from 'axios';
import OpenAI from 'openai';

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY is not set. PubMed fetch will fail.');
    return null;
  }
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

async function fetchWikipediaEntry(topic) {
  try {
    const response = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action: 'query',
        prop: 'extracts',
        explaintext: true,
        titles: topic,
        format: 'json',
      },
      headers: {
        'User-Agent': 'CommunityLens/1.0',
      },
    });
    const pages = response.data.query.pages;
    const page = Object.values(pages)[0];
    return { content: page.extract };
  } catch (error) {
    console.error('Error fetching Wikipedia entry:', error);
    throw new Error('Failed to fetch from Wikipedia');
  }
}

async function fetchPubMedConsensus(topic) {
  const openai = getOpenAIClient();
  if (!openai) {
    throw new Error('OpenAI API key is not configured.');
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `You are a Medical Research Assistant. Search your internal database ONLY for peer-reviewed clinical studies and PubMed abstracts regarding ${topic}. Summarize the scientific consensus. If there is no consensus, state that clearly. Do not use general web knowledge.`,
        },
        { role: 'user', content: topic },
      ],
    });
    return { content: response.choices[0].message.content };
  } catch (error) {
    console.error('Error fetching PubMed consensus:', error);
    throw new Error('Failed to fetch from PubMed');
  }
}

export async function fetchConsensus(topic, source) {
  if (source === 'wikipedia') {
    return fetchWikipediaEntry(topic);
  } else if (source === 'pubmed') {
    return fetchPubMedConsensus(topic);
  } else {
    throw new Error('Invalid consensus source specified');
  }
}
