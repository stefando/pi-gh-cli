import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import test from 'node:test';
import { Compile } from 'typebox/compile';
import { DEFAULT_MAX_BYTES } from '@earendil-works/pi-coding-agent';
import register from '../extensions/gh-tools.ts';

function harness({ stdout = '[]', stderr = '', code = 0 } = {}) {
  const tools = new Map();
  register({
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {},
    async exec() { return { stdout, stderr, code }; },
  });
  return {
    tools,
    async run(name, input) {
      const tool = tools.get(name);
      const result = await tool.execute('test', input, undefined, undefined, { cwd: process.cwd() });
      assert.ok(tool.outputSchema, `${name} has an output schema`);
      assert.ok(Compile(tool.outputSchema).Check(result.structuredContent), `${name} result conforms to its schema`);
      return result;
    },
  };
}

test('all 13 resources declare schemas and return structured results', async () => {
  const h = harness();
  assert.equal(h.tools.size, 13);
  for (const [name, input] of [
    ['gh_issue', { action: 'list' }], ['gh_pr', { action: 'list' }],
    ['gh_repo', { action: 'list' }], ['gh_run', { action: 'list' }],
    ['gh_workflow', { action: 'list' }], ['gh_api', { endpoint: 'repos/o/r/issues' }],
    ['gh_release', { action: 'list' }], ['gh_label', { action: 'list' }],
    ['gh_search', { scope: 'repos', query: 'pi' }], ['gh_secret', { action: 'list' }],
    ['gh_variable', { action: 'list' }], ['gh_gist', { action: 'list' }],
    ['gh_auth_status', {}],
  ]) {
    const { structuredContent: output } = await h.run(name, input);
    assert.deepEqual(output.data, []);
    assert.equal(output.exitCode, 0);
    assert.equal(output.actionClass, 'read');
    assert.equal(output.truncated, false);
    assert.ok(Array.isArray(output.warnings));
    assert.ok(Array.isArray(output.nextSuggested));
    assert.equal('text' in output, false, 'JSON should not be duplicated as text');
    assert.equal('command' in output, false, 'argv can contain secrets');
  }
});

test('JSON scalars and null remain structured data', async () => {
  for (const data of [null, false, 0, 'hello', { number: 42 }]) {
    const h = harness({ stdout: JSON.stringify(data) });
    const { structuredContent: output } = await h.run('gh_api', { endpoint: 'repos/o/r' });
    assert.ok(Object.hasOwn(output, 'data'));
    assert.deepEqual(output.data, data);
    assert.equal('text' in output, false);
  }
});

test('non-JSON output returns text rather than fake data', async () => {
  const h = harness({ stdout: 'https://github.com/o/r/issues/42\n' });
  const { structuredContent: output } = await h.run('gh_issue', { action: 'create', repo: 'o/r', title: 'test', body: 'text' });
  assert.equal(output.text, 'https://github.com/o/r/issues/42');
  assert.equal('data' in output, false);
  assert.equal(output.actionClass, 'github_mutation');
});

test('final warnings and next-step hints reach both codemode and direct callers', async () => {
  const h = harness({ stdout: '[{"number":42}]' });
  const result = await h.run('gh_search', { scope: 'code', query: 'foo', limit: 1 });
  assert.ok(result.structuredContent.warnings.some(w => w.includes('equals limit')));
  assert.ok(result.structuredContent.warnings.some(w => w.includes('rate limits')));
  for (const warning of result.structuredContent.warnings) assert.ok(result.content[0].text.includes(warning));
  const pr = await h.run('gh_pr', { action: 'view', number: '42' });
  assert.ok(pr.structuredContent.nextSuggested.some(hint => hint.includes('reviewDecision')));
  assert.ok(pr.content[0].text.includes('Next:'));
});

test('auth-status retains nonzero status and bounded stderr', async () => {
  const h = harness({ stdout: '', stderr: 'Not logged in', code: 1 });
  const { structuredContent: output } = await h.run('gh_auth_status', {});
  assert.equal(output.exitCode, 1);
  assert.equal(output.stderr, 'Not logged in');
  assert.equal(output.text, 'Not logged in');
  assert.equal(output.actionClass, 'read');
});

test('ordinary command failures still reject instead of masquerading as success', async () => {
  const h = harness({ stdout: '', stderr: 'Forbidden', code: 1 });
  await assert.rejects(h.run('gh_issue', { action: 'list' }), /Forbidden/);
});

test('truncated JSON cannot bypass the output limit through structured data', async () => {
  const data = { items: Array.from({ length: 5000 }, (_, number) => ({ number, title: 'x'.repeat(100) })) };
  const h = harness({ stdout: JSON.stringify(data), stderr: 'w'.repeat(DEFAULT_MAX_BYTES * 4) });
  const result = await h.run('gh_api', { endpoint: 'repos/o/r/issues', paginate: true });
  const output = result.structuredContent;
  try {
    assert.equal(output.truncated, true);
    assert.equal('data' in output, false);
    assert.ok(output.text.includes('Output truncated'));
    assert.ok(output.fullOutputPath);
    assert.deepEqual(JSON.parse(await readFile(output.fullOutputPath, 'utf8')), data);
    assert.ok(Buffer.byteLength(output.stderr) <= DEFAULT_MAX_BYTES);
    // At most one bounded stdout plus one bounded stderr, with small metadata overhead.
    assert.ok(Buffer.byteLength(JSON.stringify(output)) < DEFAULT_MAX_BYTES * 2 + 4096);
  } finally {
    if (output.fullOutputPath) await rm(dirname(output.fullOutputPath), { recursive: true, force: true });
  }
});
