// PATH: backend/src/services/tavily.js
const axios = require('axios');

// Domains that reliably carry live sports scores, match schedules, and
// current-event content. These are added as a soft preference — Tavily
// still crawls other domains, but these get priority weighting.
const SPORTS_DOMAINS = [
  'fifa.com', 'espn.com', 'goal.com', 'bbc.com', 'skysports.com',
  'reuters.com', 'theguardian.com', 'sofascore.com', 'flashscore.com',
  'livescore.com', 'footballreference.com'
];

// Keywords that signal the user wants live / real-time data.
// When detected we switch to a more aggressive search configuration.
const LIVE_SIGNALS = [
  'score', 'scorecard', 'live', 'current', 'right now', 'today',
  'latest', 'result', 'standings', 'table', 'fixture', 'match',
  'goal', 'half time', 'final score', 'who won', 'winner',
  'news', 'update', 'happening', 'world cup', 'championship', 'tournament',
];

function isTimeSensitiveQuery(query) {
  const q = query.toLowerCase();
  return LIVE_SIGNALS.some(signal => q.includes(signal));
}

async function searchWeb(query) {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey || apiKey.trim().length === 0) {
    console.warn('⚠️ [Tavily] TAVILY_API_KEY not set — web search skipped.');
    // Return empty string so the caller knows to skip injection entirely.
    // (Injecting fake "mock" results causes the AI to hallucinate citations.)
    return '';
  }

  // Use a deeper, broader config for queries that signal live/current data.
  // For general queries (e.g. "explain recursion") basic depth is fine and faster.
  const timeSensitive = isTimeSensitiveQuery(query);

  const requestBody = {
    api_key:        apiKey,
    query:          query,
    search_depth:   timeSensitive ? 'advanced' : 'basic',
    max_results:    timeSensitive ? 7 : 5,
    // include_answer asks Tavily to produce a short AI-generated summary of
    // the search results. For live scores this is often more accurate than
    // trying to parse raw page snippets.
    include_answer: true,
    // include_raw_content gives us the actual page text (not just the snippet)
    // for time-sensitive queries so the AI has more detail to work with.
    include_raw_content: timeSensitive,
    // For live/sports queries, prefer the known-good sports domains.
    ...(timeSensitive && { include_domains: SPORTS_DOMAINS }),
  };

  try {
    console.log(`🔍 [Tavily] ${timeSensitive ? 'ADVANCED' : 'basic'} search: "${query}"`);

    const response = await axios.post('https://api.tavily.com/search', requestBody, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 8000, // longer timeout for advanced searches
    });

    const { answer, results } = response.data;
    const parts = [];

    // Tavily's own summarized answer — when present this is often the most
    // accurate single source for "what is the score right now" style queries.
    if (answer && answer.trim().length > 0) {
      parts.push(`Direct answer from web: ${answer.trim()}`);
    }

    // Individual source pages
    if (Array.isArray(results) && results.length > 0) {
      const sources = results.map((r, idx) => {
        // Use raw content when available (advanced mode), fall back to snippet
        const body = (r.raw_content && r.raw_content.length > 0)
          ? r.raw_content.slice(0, 1200) // cap to avoid bloating context
          : r.content;
        return `Source [${idx + 1}]: ${r.url}\nTitle: ${r.title}\nContent: ${body}`;
      }).join('\n\n');
      parts.push(sources);
    }

    const output = parts.join('\n\n');
    if (!output.trim()) {
      console.warn('[Tavily] Search returned no usable content.');
      return '';
    }

    return output;

  } catch (err) {
    console.error('❌ [Tavily] Search failed:', err.message);
    // Throw so chat.js can catch it and skip injection gracefully
    throw new Error(`Tavily search failed: ${err.message}`);
  }
}

module.exports = { searchWeb };