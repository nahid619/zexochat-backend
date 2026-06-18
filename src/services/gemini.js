const { GoogleGenerativeAI } = require('@google/generative-ai');

async function callGemini(modelId, messages) {
  // Single key, single Google Cloud project — intentionally not rotating
  // across multiple keys/projects/accounts. Gemini's free-tier quota is
  // pooled per project, not per key, and creating multiple projects/accounts
  // to multiply it trips Google's abuse detection (confirmed firsthand — see
  // the "Unavailable" billing-tier issue on the second project we tried).
  // If you need more throughput than one project's free tier gives you, the
  // sanctioned path is enabling billing on this one project (Tier 1), not
  // adding more keys here.
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is missing');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  // FIX: switched default to gemini-3.1-flash-lite — the current GA "workhorse"
  // model per Google's changelog (released May 7, 2026). NOT
  // gemini-3.1-flash-lite-preview — that's a different, now-dead id: it was
  // deprecated May 11 and fully shut down May 25, 2026, despite being the
  // model an earlier (March 31) changelog entry recommended at the time.
  // This branch is defensive only — it never actually fires today, since
  // callProvider only routes provider:'google' entries here, and every
  // Gemini id in MODEL_CHAIN already starts with "gemini-".
  const modelName = modelId.startsWith('gemini-') ? modelId : 'gemini-3.1-flash-lite';
  
  const model = genAI.getGenerativeModel({ model: modelName });
  
  // Format history for Gemini API: [{ role: 'user' | 'model', parts: [{ text: string }] }]
  const history = messages.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  
  const lastMsg = messages[messages.length - 1].content;
  
  // Start chat with history
  const chat = model.startChat({ history });
  const result = await chat.sendMessage(lastMsg);
  const responseText = result.response.text();
  
  if (!responseText) {
    throw new Error('Gemini returned an empty response');
  }
  
  return responseText;
}

module.exports = { callGemini };