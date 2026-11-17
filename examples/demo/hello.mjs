const response = await fetch(`${process.env.OPENAI_BASE_URL}/responses`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
    'User-Agent': 'ZeroKey-Demo/0.1',
    'x-litellm-session-id': process.env.LITELLM_SESSION_ID,
  },
  body: JSON.stringify({model: process.env.LLM_MODEL, input: 'Reply with exactly: OK', max_output_tokens: 32}),
});
if (!response.ok) { console.error(`Gateway rejected the request (HTTP ${response.status}).`); process.exit(1); }
const data = await response.json();
const text = (data.output ?? []).flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join('');
if (!text) { console.error('The model returned no text.'); process.exit(1); }
console.log(JSON.stringify({model: process.env.LLM_MODEL, text, tokens: data.usage?.total_tokens}, null, 2));
