const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectAgent, agentSystem, reviewResult } = require('../lib/agents');

test('Auto uses conservative task routing and explicit selection wins', () => {
  const currentCode = '<html></html>';
  assert.equal(selectAgent({ prompt: 'Build a dashboard' }), 'build');
  assert.equal(selectAgent({ prompt: 'Fix the login', currentCode }), 'debug');
  assert.equal(selectAgent({ prompt: 'Review access rules', currentCode }), 'review');
  assert.equal(selectAgent({ prompt: 'Add a review button', currentCode }), 'build');
  assert.equal(selectAgent({ agent: 'build', prompt: 'Review the page', currentCode }), 'build');
});
test('Invalid agents and reviews/debugging without projects fail before generation', () => {
  assert.throws(() => selectAgent({ agent: 'unknown' }));
  assert.throws(() => selectAgent({ agent: 'review' }));
  assert.throws(() => selectAgent({ agent: 'debug', kind: 'multi', files: {} }));
  assert.equal(selectAgent({ agent: 'review', kind: 'multi', files: { 'src/App.jsx': 'code' } }), 'review');
});
test('Review uses a separate prompt and treats even patch-like output as a report', () => {
  const text = 'FILE: src/App.jsx\n```jsx\nmalicious replacement\n```';
  assert.deepEqual(reviewResult('review', text), { report: text, files: null });
  assert.equal(reviewResult('build', text), null);
  assert.ok(!agentSystem('review', 'OUTPUT REPLACEMENT HTML').includes('OUTPUT REPLACEMENT HTML'));
  assert.match(agentSystem('review', ''), /no execution tools/);
  assert.match(agentSystem('debug', 'FORMAT'), /^FORMAT/);
});
