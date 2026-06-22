const express = require('express');
const router = express.Router();

// Gemini entries re-verified against the freshest pricing-page fetch
// (ai.google.dev/gemini-api/docs/pricing, fetched 2026-06-17, page stamped
// "Last updated 2026-06-15"). Correcting two earlier mistakes:
//   - `gemini-3.5-flash` IS real, GA, and free — added below. It's the new
//     flagship Flash model; I wrongly called it fake earlier based on an
//     incomplete fetch of the same page.
//   - `gemini-3.1-flash-lite-preview` has graduated to GA and dropped the
//     "-preview" suffix — the correct current id is `gemini-3.1-flash-lite`.
//     My earlier "fix" adding the suffix back was wrong.
//   - `gemini-2.5-flash` and `gemini-2.5-flash-lite` remain confirmed free.
//   - rpdFree values below are rough, typical free-tier daily-request estimates
//     for display purposes only — Google doesn't publish a single fixed RPD per
//     model, and actual quota varies by account/region.
const MODELS = [
  { id: 'gemini-3.5-flash', provider: 'google', name: 'Gemini 3.5 Flash', score: 8.6, rpdFree: 250 },
  { id: 'gemini-3-flash-preview', provider: 'google', name: 'Gemini 3 Flash Preview', score: 8.3, rpdFree: 250 },
  { id: 'gemini-2.5-flash', provider: 'google', name: 'Gemini 2.5 Flash', score: 8.0, rpdFree: 250 },
  { id: 'gemini-3.1-flash-lite', provider: 'google', name: 'Gemini 3.1 Flash-Lite', score: 7.7, rpdFree: 1000 },
  { id: 'gemini-2.5-flash-lite', provider: 'google', name: 'Gemini 2.5 Flash-Lite', score: 7.4, rpdFree: 1000 },
  // gemini-2.5-pro removed — NOT on the free tier (confirmed via billing)
  { id: 'openai/gpt-oss-120b', provider: 'groq', name: 'GPT-OSS 120B (Groq)', score: 7.5, rpdFree: 1000 },
  { id: 'llama-3.3-70b-versatile', provider: 'groq', name: 'Llama 3.3 70B', score: 7.2, rpdFree: 1000 },
  { id: 'llama-4-scout', provider: 'groq', name: 'Llama 4 Scout', score: 7.2, rpdFree: 1000 },
  { id: 'command-r-plus', provider: 'cohere', name: 'Command R+', score: 6.9, rpdFree: 1000 },
  { id: 'meta-llama/Llama-3.1-70B-Instruct', provider: 'huggingface', name: 'Llama 3.1 70B (HF)', score: 6.7, rpdFree: 500 },
  { id: 'llama-3.1-8b-instant', provider: 'groq', name: 'Llama 3.1 8B (fast)', score: 6.3, rpdFree: 1000 },
  { id: 'mistral-small-latest', provider: 'mistral', name: 'Mistral Small', score: 5.5, rpdFree: 200 }
];

router.get('/', (req, res) => {
  res.json(MODELS);
});

module.exports = router;