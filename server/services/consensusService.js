import axios from 'axios';
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
  console.warn("OPENAI_API_KEY not found. PubMed consensus will fail if called.");
}

const fetchWikipediaEntry = async (topic) => {
  try {
    const response = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action: 'query',
        format: 'json',
        prop: 'extracts',
        exintro: true,
        explaintext: true,
        titles: topic,
        origin: '*'
      },
      headers: {
        'User-Agent': 'CommunityLens/1.0'
      }
    });

    const pages = response.data.query.pages;
    const pageId = Object.keys(pages)[0];

    if (pageId === '-1') {
      return "Wikipedia entry not found.";
    }

    return pages[pageId].extract;
  } catch (error) {
    console.error("Wikipedia Fetch Error:", error);
    throw new Error("Failed to fetch from Wikipedia.");
  }
};

const fetchPubMedConsensus = async (topic) => {
  if (!openai) {
    throw new Error("OPENAI_API_KEY is missing.");
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `You are a Medical Research Assistant. Search your internal database ONLY for peer-reviewed clinical studies and PubMed abstracts regarding ${topic}. Summarize the scientific consensus. If there is no consensus, state that clearly. Do not use general web knowledge.`
        },
        { role: "user", content: topic }
      ],
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error("PubMed Fetch Error:", error);
    throw new Error("Failed to fetch from PubMed.");
  }
};

export const fetchConsensus = async (topic, mode) => {
  if (mode === 'medical') {
    const [wikiText, pubmedText] = await Promise.all([
      fetchWikipediaEntry(topic),
      fetchPubMedConsensus(topic)
    ]);
    return `Wikipedia:\n${wikiText}\n\nPubMed:\n${pubmedText}`;
  } else {
    return fetchWikipediaEntry(topic);
  }
};
