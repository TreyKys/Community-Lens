import axios from 'axios';

export const fetchWikipediaEntry = async (topic) => {
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
        'User-Agent': 'CommunityLens_HackathonBot/1.0 (contact@communitylens.xyz)'
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
