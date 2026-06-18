const axios = require('axios');

async function searchWeb(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    console.warn('⚠️ TAVILY_API_KEY is not defined. Using Mock Web Search Context.');
    // Return mock results for demonstration
    return `Source: https://example.com/mock-search-result-1\nThis is a mock search result for the query "${query}". AuraChat supports real web retrieval using Tavily API.\n\nSource: https://example.com/mock-search-result-2\nTo enable live Tavily web search, sign up at app.tavily.com and paste your key in backend/.env as TAVILY_API_KEY.`;
  }

  try {
    const response = await axios.post('https://api.tavily.com/search', {
      api_key: apiKey,
      query: query,
      max_results: 3,
      search_depth: 'basic'
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 5000 // 5 seconds timeout
    });

    if (response.data && Array.isArray(response.data.results)) {
      const formattedResults = response.data.results
        .map((r, idx) => `Source [${idx + 1}]: ${r.url}\nTitle: ${r.title}\nContent: ${r.content}`)
        .join('\n\n');
      return formattedResults;
    }

    return '';
  } catch (err) {
    console.error('❌ Tavily Web Search API Error:', err.message);
    throw new Error(`Tavily search request failed: ${err.message}`);
  }
}

module.exports = { searchWeb };
