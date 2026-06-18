const Groq = require('groq-sdk');

async function callGroq(modelId, messages) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is missing');
  }

  const groq = new Groq({ apiKey });
  
  // Format messages list for Groq API
  const formattedMessages = messages.map(m => ({
    role: m.role,
    content: m.content
  }));

  const completion = await groq.chat.completions.create({
    model: modelId,
    messages: formattedMessages,
  });

  if (!completion.choices || completion.choices.length === 0) {
    throw new Error('Groq returned an empty response');
  }

  return completion.choices[0].message.content;
}

module.exports = { callGroq };
