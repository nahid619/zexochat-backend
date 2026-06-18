const { callGemini } = require('./gemini');
const { callGroq } = require('./groq');
const { callHuggingFace } = require('./huggingface'); // FIX: added missing HuggingFace import
const axios = require('axios');

// Gemini model chain — re-verified against the freshest possible source:
// ai.google.dev/gemini-api/docs/pricing, fetched 2026-06-17, page itself stamped
// "Last updated 2026-06-15". Correcting two of my own earlier mistakes here:
//   - `gemini-3.5-flash` IS real and GA — it's the new flagship Flash model,
//     and Google's own migration guide recommends moving from
//     `gemini-3-flash-preview` to it. I wrongly called it fake earlier today
//     based on an incomplete pricing-page fetch; confirmed free of charge.
//   - `gemini-3.1-flash-lite-preview` no longer appears on the pricing page at
//     all — it has graduated to GA and the id dropped the "-preview" suffix,
//     same pattern as 3.5 Flash. The correct current id is
//     `gemini-3.1-flash-lite` (no suffix). My earlier "fix" that added the
//     suffix back was wrong; the original code had this one right.
//   - `gemini-3-flash-preview`, `gemini-2.5-flash`, and `gemini-2.5-flash-lite`
//     are all still listed "Free of charge" and kept as-is. Google's own 3.5
//     migration guide explicitly says 3-flash-preview "remains available" —
//     it is NOT deprecated, despite a claim to that effect from elsewhere.
//   - `gemini-2.5-pro` added below: confirmed free of charge (input + output)
//     on the Standard free tier, with its own separate quota pool from the
//     Flash models. Placed after the higher-volume Flash models in this list
//     since Pro's free daily quota is much smaller — this way the high-volume
//     models absorb most traffic and Pro is held in reserve rather than
//     burned on every single request.
//   - The only Gemini text model that's genuinely paid-only right now is
//     `gemini-3.1-pro-preview` (Free Tier: "Not available") — do NOT add it
//     here, it would silently fail on a free-tier-only setup like this one.
//   - Do NOT add `gemini-1.5-flash` / `gemini-1.5-pro` — both were shut down
//     September 29, 2025, despite a claim elsewhere that they have "fresh"
//     free quota.
//   - Do NOT add audio/image/video Gemini models (flash-live, flash-tts,
//     flash-image, veo, etc.) to this chain — they use entirely different
//     request shapes than generateContent text completions and aren't
//     swappable fallbacks for a text chat router.
const MODEL_CHAIN = [
  { id: 'gemini-3.5-flash', provider: 'google' },        // free — flagship
  { id: 'gemini-3-flash-preview', provider: 'google' },  // free
  { id: 'gemini-2.5-flash', provider: 'google' },        // free
  { id: 'gemini-3.1-flash-lite', provider: 'google' },   // free — GA, no "-preview"
  { id: 'gemini-2.5-flash-lite', provider: 'google' },   // free
  { id: 'gemini-2.5-pro', provider: 'google' },          // free — small quota, held in reserve
  { id: 'openai/gpt-oss-120b', provider: 'groq' },
  { id: 'llama-3.3-70b-versatile', provider: 'groq' },
  { id: 'llama-4-scout', provider: 'groq' },
  { id: 'llama-3.1-8b-instant', provider: 'groq' },
  { id: 'command-r-plus', provider: 'cohere' },
  { id: 'meta-llama/Llama-3.1-70B-Instruct', provider: 'huggingface' },
  { id: 'mistral-small-latest', provider: 'mistral' }
];

// FIX: OpenRouter requires its own namespaced model slugs, not raw provider IDs.
// Passing `command-r-plus` or `llama-3.3-70b-versatile` to OpenRouter returned 404s.
const OPENROUTER_MODEL_MAP = {
  'openai/gpt-oss-120b':                'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile':            'meta-llama/llama-3.3-70b-instruct',
  'llama-4-scout':                      'meta-llama/llama-4-scout',
  'llama-3.1-8b-instant':              'meta-llama/llama-3.1-8b-instruct',
  'command-r-plus':                     'cohere/command-r-plus',
  'meta-llama/Llama-3.1-70B-Instruct': 'meta-llama/llama-3.1-70b-instruct',
  'mistral-small-latest':              'mistralai/mistral-small'
};

// Cooldown storage: modelId → timestamp (ms) when cooldown expires
const cooldowns = new Map();

// OpenRouter — uses the ID map to translate provider-specific IDs to OR slugs
async function callOpenRouter(modelId, messages) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing');

  // FIX: translate to OpenRouter's model slug; fall back to the original ID if not in map
  const orModelId = OPENROUTER_MODEL_MAP[modelId] || modelId;

  const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: orModelId,
    messages: messages.map(m => ({ role: m.role, content: m.content }))
  }, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:5173',
    }
  });

  if (!response.data?.choices?.[0]?.message?.content) {
    throw new Error('OpenRouter returned an empty response');
  }

  return response.data.choices[0].message.content;
}

// Cohere direct API
async function callCohere(modelId, messages) {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) throw new Error('COHERE_API_KEY is missing');

  const response = await axios.post('https://api.cohere.com/v1/chat', {
    model: modelId,
    message: messages[messages.length - 1].content,
    chat_history: messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'CHATBOT' : 'USER',
      message: m.content
    }))
  }, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.data?.text) {
    throw new Error('Cohere returned an empty response');
  }

  return response.data.text;
}

// Mistral direct API
async function callMistral(modelId, messages) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY is missing');

  const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
    model: modelId,
    messages: messages.map(m => ({ role: m.role, content: m.content }))
  }, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.data?.choices?.[0]?.message?.content) {
    throw new Error('Mistral returned an empty response');
  }

  return response.data.choices[0].message.content;
}

// Unified provider dispatcher
async function callProvider(model, messages) {
  // Try OpenRouter first for non-Google models if key available (it can consolidate)
  if (process.env.OPENROUTER_API_KEY && model.provider !== 'google') {
    try {
      return await callOpenRouter(model.id, messages);
    } catch (e) {
      console.warn(`[aiRouter] OpenRouter failed for ${model.id} (${e.message}), trying direct provider…`);
    }
  }

  switch (model.provider) {
    case 'google':
      return await callGemini(model.id, messages);
    case 'groq':
      return await callGroq(model.id, messages);
    case 'cohere':
      return await callCohere(model.id, messages);
    case 'mistral':
      return await callMistral(model.id, messages);
    case 'huggingface':
      return await callHuggingFace(model.id, messages);
    default:
      throw new Error(`No direct API configured for provider: ${model.provider}`);
  }
}

// Mock response for testing / dev without API keys
function generateMockResponse(modelId, messages) {
  const lastMsg = messages[messages.length - 1].content;
  const historyCount = messages.length - 1;

  if (lastMsg.toLowerCase().includes('search') || lastMsg.toLowerCase().includes('source:')) {
    return `🔍 **Mock Web Search Answer** (via **${modelId}**)

Based on retrieved web results:

1. ZexoChat is a multi-model chat app with automatic fallback routing.
2. It supports **11 free AI models** from Google, Groq, Cohere, Mistral, and HuggingFace.
3. If any model hits its rate limit, the router silently switches to the next in the chain.

Is there anything specific you'd like to search for?`;
  }

  if (lastMsg.toLowerCase().includes('name')) {
    return `My name is **ZexoChat**! I'm currently running on a simulated **${modelId}** model. Nice to meet you!`;
  }

  return `✨ **Simulated Response** (via **${modelId}**)

- **User query:** "${lastMsg}"
- **Context history:** ${historyCount} message(s) loaded

To test rate-limit auto-switching, type **"rate limit"** and watch the router skip this model and try the next one in the chain.`;
}

// Master routing function
async function routeChat(messages, preferredModel = null, forceMock = false) {
  const lastUserMessage = messages[messages.length - 1].content;
  const isSimulatedLimitRequested =
    lastUserMessage.toLowerCase().includes('rate limit') ||
    lastUserMessage.toLowerCase().includes('force switch') ||
    lastUserMessage.toLowerCase().includes('sim limit');

  const hasKeys = !!(
    process.env.GEMINI_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.COHERE_API_KEY ||
    process.env.MISTRAL_API_KEY ||
    process.env.HUGGINGFACE_API_KEY
  );

  const useMockMode = forceMock || !hasKeys;

  // Build chain, preferred model first
  let chain = [...MODEL_CHAIN];
  if (preferredModel) {
    const pref = MODEL_CHAIN.find(m => m.id === preferredModel);
    if (pref) {
      chain = [pref, ...MODEL_CHAIN.filter(m => m.id !== preferredModel)];
    }
  }

  for (const model of chain) {
    // Skip models on cooldown
    const cooldownUntil = cooldowns.get(model.id);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      console.log(`[aiRouter] Skipping ${model.id} (cooldown ${Math.round((cooldownUntil - Date.now()) / 1000)}s remaining)`);
      continue;
    }

    // Simulate rate limit if requested
    if (useMockMode && isSimulatedLimitRequested) {
      cooldowns.set(model.id, Date.now() + 40000);
      console.log(`⚠️ [aiRouter] Simulated 429 on ${model.id}. Trying next…`);
      continue;
    }

    try {
      if (useMockMode) {
        console.log(`✨ [aiRouter] Mock response via: ${model.id}`);
        await new Promise(resolve => setTimeout(resolve, 800));
        return { content: generateMockResponse(model.id, messages), modelUsed: model.id };
      } else {
        console.log(`🔌 [aiRouter] Real call: ${model.id} (${model.provider})`);
        const content = await callProvider(model, messages);
        return { content, modelUsed: model.id };
      }
    } catch (err) {
      const isRateLimit =
        err.response?.status === 429 ||
        err.status === 429 ||
        (err.message && (
          err.message.includes('429') ||
          err.message.toLowerCase().includes('rate limit') ||
          err.message.toLowerCase().includes('quota') ||
          err.message.toLowerCase().includes('too many requests')
        ));

      if (isRateLimit) {
        cooldowns.set(model.id, Date.now() + 60000);
        console.warn(`⚠️ [aiRouter] ${model.id} rate limited (429). Trying next…`);
        continue;
      }

      if (err.message && (err.message.includes('missing') || err.message.includes('not configured'))) {
        console.warn(`⚠️ [aiRouter] ${model.id} skipped — missing key: ${err.message}`);
        cooldowns.set(model.id, Date.now() + 10000);
        continue;
      }

      console.error(`❌ [aiRouter] Error on ${model.id}:`, err.message);
      cooldowns.set(model.id, Date.now() + 30000);
      continue;
    }
  }

  if (isSimulatedLimitRequested) {
    cooldowns.clear();
    throw new Error('All models rate-limited in simulation. Cooldowns cleared — try again!');
  }

  throw new Error('All available AI models are rate-limited or unconfigured. Please try again in a minute.');
}

module.exports = { routeChat, MODEL_CHAIN };