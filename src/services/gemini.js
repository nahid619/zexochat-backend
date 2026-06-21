// PATH: backend/src/services/gemini.js
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function callGemini(modelId, messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is missing');

  const genAI    = new GoogleGenerativeAI(apiKey);
  const modelName = modelId.startsWith('gemini-') ? modelId : 'gemini-3.1-flash-lite';

  // Gemini uses a separate systemInstruction field rather than a message role.
  // Pull it out of the array so it never ends up in chat history as a 'user' turn.
  const systemMsg       = messages.find(m => m.role === 'system');
  const convoMessages   = messages.filter(m => m.role !== 'system');

  const modelConfig = { model: modelName };
  if (systemMsg?.content) {
    modelConfig.systemInstruction = systemMsg.content;
  }

  const model = genAI.getGenerativeModel(modelConfig);

  // Gemini history = all turns except the very last one (which becomes sendMessage)
  const history = convoMessages.slice(0, -1).map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const lastMsg = convoMessages[convoMessages.length - 1].content;

  const chat        = model.startChat({ history });
  const result      = await chat.sendMessage(lastMsg);
  const responseText = result.response.text();

  if (!responseText) throw new Error('Gemini returned an empty response');
  return responseText;
}

module.exports = { callGemini };