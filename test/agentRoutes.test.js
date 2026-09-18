// Real Express routing/SSE with an offline model stub. No provider or database calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']) delete process.env[key];
const calls = [];
const output = 'FILE: src/App.jsx\n```jsx\nexport default function App(){return <h1>Changed</h1>}\n```';
class FakeModel {
  constructor() {
    this.messages = {
      countTokens: async args => { calls.push(args); return { input_tokens: 100 }; },
      stream: args => {
        calls.push(args);
        return { on() {}, finalMessage: async () => ({ content: [{ type: 'text', text: output }], usage: { input_tokens: 100, output_tokens: 100 }, stop_reason: 'end_turn', model: 'offline-test' }) };
      },
    };
  }
}
const sdkPath = require.resolve('@anthropic-ai/sdk');
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: FakeModel };
const app = require('../lib/app');
test('Estimate and SSE use the same mode; review cannot emit applicable files', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-anthropic-key': 'offline-placeholder' }, body: JSON.stringify(body) });
  try {
    const body = { agent: 'auto', prompt: 'Review my code', kind: 'multi', files: { 'src/App.jsx': 'original' } };
    const estimate = await (await request('/api/estimate', body)).json();
    assert.equal(estimate.agent, 'review');
    const response = await request('/api/generate', body);
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split('\n\n').map(line => JSON.parse(line.slice(6)));
    const done = events.find(event => event.type === 'done');
    assert.equal(done.agent, 'review');
    assert.equal(done.files, null);
    assert.equal(done.report, output);
    assert.ok(done.cost > 0, 'review records actual model cost');
    assert.equal(calls[0].system, calls[1].system[0].text);
    assert.deepEqual(calls[0].messages, calls[1].messages);
    const before = calls.length;
    assert.equal((await request('/api/generate', { agent: 'review', prompt: 'Review' })).status, 400);
    assert.equal(calls.length, before, 'invalid requests do not invoke the provider');
    const buildResponse = await request('/api/generate', { ...body, agent: 'build' });
    const buildEvents = (await buildResponse.text()).trim().split('\n\n').map(line => JSON.parse(line.slice(6)));
    assert.ok(buildEvents.find(event => event.type === 'done').files['src/App.jsx']);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
