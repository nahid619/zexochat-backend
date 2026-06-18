const axios = require('axios');

/**
 * HuggingFace Serverless Inference API
 * Uses the Messages API (OpenAI-compatible) for chat models.
 * Docs: https://huggingface.co/docs/api-inference/tasks/chat-completion
 */
async function callHuggingFace(modelId, messages) {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) {
    throw new Error('HUGGINGFACE_API_KEY is missing');
  }

  try {
    const response = await axios.post(
      `https://api-inference.huggingface.co/models/${modelId}/v1/chat/completions`,
      {
        model: modelId,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content
        })),
        max_tokens: 1024,
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000, // 30 second timeout — HF cold starts can be slow
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('HuggingFace returned an empty response');
    }

    return content;
  } catch (err) {
    // HuggingFace returns 503 when a model is loading (cold start) — treat as rate limit
    if (err.response?.status === 503) {
      const retryAfter = err.response?.data?.error?.includes('loading') ? true : false;
      const msg = retryAfter
        ? 'HuggingFace model is loading (cold start). Will retry shortly.'
        : 'HuggingFace service unavailable (503).';
      const rateErr = new Error(msg);
      rateErr.status = 429; // map to 429 so aiRouter triggers cooldown + fallback
      throw rateErr;
    }

    if (err.response?.status === 429) {
      const rateErr = new Error('HuggingFace rate limit reached (429).');
      rateErr.status = 429;
      throw rateErr;
    }

    throw new Error(`HuggingFace API error: ${err.response?.data?.error || err.message}`);
  }
}

module.exports = { callHuggingFace };