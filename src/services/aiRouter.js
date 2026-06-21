// PATH: backend/src/services/aiRouter.js
const { callGemini }     = require('./gemini');
const { callGroq }       = require('./groq');
const { callHuggingFace } = require('./huggingface');
const axios              = require('axios');

// ─── Model chain ──────────────────────────────────────────────────────────────
// gemini-2.5-pro is NOT on the free tier (confirmed via billing dashboard) —
// do NOT re-add it. All other Gemini entries below are verified free.
const MODEL_CHAIN = [
  { id: 'gemini-3.5-flash',        provider: 'google' }, // free — flagship
  { id: 'gemini-3-flash-preview',  provider: 'google' }, // free
  { id: 'gemini-2.5-flash',        provider: 'google' }, // free
  { id: 'gemini-3.1-flash-lite',   provider: 'google' }, // free — GA, no -preview suffix
  { id: 'gemini-2.5-flash-lite',   provider: 'google' }, // free
  { id: 'openai/gpt-oss-120b',     provider: 'groq'   },
  { id: 'llama-3.3-70b-versatile', provider: 'groq'   },
  { id: 'llama-4-scout',           provider: 'groq'   },
  { id: 'llama-3.1-8b-instant',    provider: 'groq'   },
  { id: 'command-r-plus',          provider: 'cohere' },
  { id: 'meta-llama/Llama-3.1-70B-Instruct', provider: 'huggingface' },
  { id: 'mistral-small-latest',    provider: 'mistral' },
];

// OpenRouter uses its own namespaced slugs
const OPENROUTER_MODEL_MAP = {
  'openai/gpt-oss-120b':                'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile':            'meta-llama/llama-3.3-70b-instruct',
  'llama-4-scout':                      'meta-llama/llama-4-scout',
  'llama-3.1-8b-instant':              'meta-llama/llama-3.1-8b-instruct',
  'command-r-plus':                     'cohere/command-r-plus',
  'meta-llama/Llama-3.1-70B-Instruct': 'meta-llama/llama-3.1-70b-instruct',
  'mistral-small-latest':              'mistralai/mistral-small',
};

// Cooldown storage: modelId → timestamp (ms) when cooldown expires
const cooldowns = new Map();

// ─── Provider callers ─────────────────────────────────────────────────────────

// OpenAI-compatible providers (Groq, Mistral, OpenRouter) handle the
// `system` role natively — no special treatment needed.

async function callOpenRouter(modelId, messages) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing');

  const orModelId  = OPENROUTER_MODEL_MAP[modelId] || modelId;
  const response   = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model:    orModelId,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:5173',
      },
    }
  );

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter returned an empty response');
  return content;
}

// Cohere uses a distinct API shape: last message goes in `message`,
// earlier turns go in `chat_history`, and the system prompt goes in `preamble`.
async function callCohere(modelId, messages) {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) throw new Error('COHERE_API_KEY is missing');

  // Extract system message — Cohere exposes this as `preamble`
  const systemMsg      = messages.find(m => m.role === 'system');
  const convoMessages  = messages.filter(m => m.role !== 'system');

  const body = {
    model:        modelId,
    message:      convoMessages[convoMessages.length - 1].content,
    chat_history: convoMessages.slice(0, -1).map(m => ({
      role:    m.role === 'assistant' ? 'CHATBOT' : 'USER',
      message: m.content,
    })),
  };

  if (systemMsg?.content) {
    body.preamble = systemMsg.content;
  }

  const response = await axios.post('https://api.cohere.com/v1/chat', body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  const text = response.data?.text;
  if (!text) throw new Error('Cohere returned an empty response');
  return text;
}

async function callMistral(modelId, messages) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY is missing');

  const response = await axios.post(
    'https://api.mistral.ai/v1/chat/completions',
    {
      model:    modelId,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Mistral returned an empty response');
  return content;
}

// ─── Unified dispatcher ───────────────────────────────────────────────────────
async function callProvider(model, messages) {
  // Try OpenRouter first for non-Google models when key is available
  if (process.env.OPENROUTER_API_KEY && model.provider !== 'google') {
    try {
      return await callOpenRouter(model.id, messages);
    } catch (e) {
      console.warn(`[aiRouter] OpenRouter failed for ${model.id} (${e.message}), trying direct…`);
    }
  }

  switch (model.provider) {
    case 'google':      return await callGemini(model.id, messages);
    case 'groq':        return await callGroq(model.id, messages);
    case 'cohere':      return await callCohere(model.id, messages);
    case 'mistral':     return await callMistral(model.id, messages);
    case 'huggingface': return await callHuggingFace(model.id, messages);
    default:
      throw new Error(`No direct API configured for provider: ${model.provider}`);
  }
}

// ─── Mock mode (dev without API keys) ────────────────────────────────────────
function generateMockResponse(modelId, messages) {
  const lastMsg     = messages.filter(m => m.role !== 'system').at(-1)?.content || '';
  const historyCount = messages.filter(m => m.role === 'user').length - 1;

  if (lastMsg.toLowerCase().includes('time') || lastMsg.toLowerCase().includes('date')) {
    return `🕐 **Mock Time Response** (via **${modelId}**)\n\nThe system clock has been injected into my context. In real mode I would tell you the exact local time you sent in your request.`;
  }

  if (lastMsg.includes('Source [')) {
    return `🔍 **Mock Web Search Answer** (via **${modelId}**)\n\nBased on retrieved web results I would summarise the key facts here.`;
  }

  return `✨ **Simulated Response** (via **${modelId}**)\n\n- Query: "${lastMsg}"\n- Context turns: ${historyCount}\n\nType **"rate limit"** to test auto-switching.`;
}

// ─── Master routing function ──────────────────────────────────────────────────
async function routeChat(messages, preferredModel = null, forceMock = false) {
  const lastUserMessage = messages.filter(m => m.role !== 'system').at(-1)?.content || '';

  const isSimulatedLimitRequested =
    lastUserMessage.toLowerCase().includes('rate limit') ||
    lastUserMessage.toLowerCase().includes('force switch') ||
    lastUserMessage.toLowerCase().includes('sim limit');

  const hasKeys = !!(
    process.env.GEMINI_API_KEY      ||
    process.env.GROQ_API_KEY        ||
    process.env.OPENROUTER_API_KEY  ||
    process.env.COHERE_API_KEY      ||
    process.env.MISTRAL_API_KEY     ||
    process.env.HUGGINGFACE_API_KEY
  );

  const useMockMode = forceMock || !hasKeys;

  // Build chain, preferred model first
  let chain = [...MODEL_CHAIN];
  if (preferredModel) {
    const pref = MODEL_CHAIN.find(m => m.id === preferredModel);
    if (pref) chain = [pref, ...MODEL_CHAIN.filter(m => m.id !== preferredModel)];
  }

  for (const model of chain) {
    const cooldownUntil = cooldowns.get(model.id);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      const secsLeft = Math.round((cooldownUntil - Date.now()) / 1000);
      console.log(`[aiRouter] Skipping ${model.id} (cooldown ${secsLeft}s remaining)`);
      continue;
    }

    if (useMockMode && isSimulatedLimitRequested) {
      cooldowns.set(model.id, Date.now() + 40_000);
      console.log(`⚠️ [aiRouter] Simulated 429 on ${model.id}. Trying next…`);
      continue;
    }

    try {
      if (useMockMode) {
        console.log(`✨ [aiRouter] Mock response via: ${model.id}`);
        await new Promise(r => setTimeout(r, 800));
        return { content: generateMockResponse(model.id, messages), modelUsed: model.id };
      }

      console.log(`🔌 [aiRouter] Real call: ${model.id} (${model.provider})`);
      const content = await callProvider(model, messages);
      return { content, modelUsed: model.id };

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
        cooldowns.set(model.id, Date.now() + 60_000);
        console.warn(`⚠️ [aiRouter] ${model.id} rate limited. Trying next…`);
        continue;
      }

      if (err.message?.includes('missing') || err.message?.includes('not configured')) {
        console.warn(`⚠️ [aiRouter] ${model.id} skipped — missing key: ${err.message}`);
        cooldowns.set(model.id, Date.now() + 10_000);
        continue;
      }

      console.error(`❌ [aiRouter] Error on ${model.id}:`, err.message);
      cooldowns.set(model.id, Date.now() + 30_000);
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