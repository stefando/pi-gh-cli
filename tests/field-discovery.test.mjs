import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { promisify } from 'node:util';
import { Compile } from 'typebox/compile';
import register from '../extensions/gh-tools.ts';

const execFileAsync = promisify(execFile);
const diagnostic = 'Specify one or more comma-separated fields for `--json`:\n  comments\n  number\n  title\n';

function harness(response = { code: 1, stdout: '', stderr: diagnostic }) {
  const tools = new Map();
  const calls = [];
  register({
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {},
    async exec(command, args) {
      calls.push({ command, args });
      return typeof response === 'function' ? response(command, args) : response;
    },
  });
  return {
    calls,
    async run(name, input) {
      const tool = tools.get(name);
      const result = await tool.execute('test', { ...input, fields: '*' }, undefined, undefined, { cwd: tmpdir() });
      assert.ok(Compile(tool.outputSchema).Check(result.structuredContent));
      return result.structuredContent;
    },
  };
}

test('view discovery ignores comments and jq and does not require a target', async () => {
  for (const name of ['gh_issue', 'gh_pr']) {
    const h = harness();
    const output = await h.run(name, { action: 'view', comments: true, jq: '.comments', repo: 'o/r' });
    assert.deepEqual(h.calls[0].args, [name.slice(3), 'view', '--json']);
    assert.deepEqual(output.data, { availableFields: ['comments', 'number', 'title'] });
    assert.equal(output.exitCode, 1, 'preserve the expected gh diagnostic exit code');
    assert.equal(output.actionClass, 'read');
    assert.equal(output.truncated, false);
  }
});

test('search discovery omits all queries and flags, including negative qualifiers', async () => {
  const h = harness();
  await h.run('gh_search', { scope: 'issues', query: 'bug -label:wontfix', jq: '.[]', searchType: 'semantic', limit: 5, repo: ['o/r'] });
  assert.deepEqual(h.calls[0].args, ['search', 'issues', '--json']);
  const code = harness();
  await code.run('gh_search', { scope: 'code', query: 'foo' });
  assert.deepEqual(code.calls[0].args, ['search', 'code', '--json']);
});

test('discovery bypasses incompatible output modes on supported commands', async () => {
  for (const [name, input, expected] of [
    ['gh_pr', { action: 'checks', watch: true }, ['pr', 'checks', '--json']],
    ['gh_run', { action: 'view', log: true, logFailed: true }, ['run', 'view', '--json']],
    ['gh_repo', { action: 'view', branch: 'main' }, ['repo', 'view', '--json']],
    ['gh_workflow', { action: 'list', all: true }, ['workflow', 'list', '--json']],
    ['gh_release', { action: 'view', tag: 'v1' }, ['release', 'view', '--json']],
    ['gh_label', { action: 'list', search: 'bug' }, ['label', 'list', '--json']],
  ]) {
    const h = harness();
    await h.run(name, input);
    assert.deepEqual(h.calls[0].args, expected);
  }
});

test('unsupported discovery never runs an operation or a mutation', async () => {
  const h = harness();
  for (const [name, input] of [
    ['gh_issue', { action: 'create', title: 'must not create' }],
    ['gh_pr', { action: 'diff' }], ['gh_workflow', { action: 'view' }],
    ['gh_gist', { action: 'list' }],
  ]) await assert.rejects(h.run(name, input), /discovery is not supported/);
  assert.equal(h.calls.length, 0);
});

test('only the exact expected diagnostic is accepted, not arbitrary failures', async () => {
  for (const response of [
    { code: 1, stdout: '', stderr: 'Not logged in' },
    { code: 1, stdout: '', stderr: 'unknown flag: --json' },
    { code: 1, stdout: '', stderr: 'Specify one or more comma-separated fields for `--json`:\n' },
    { code: 2, stdout: '', stderr: diagnostic },
    { code: 0, stdout: '', stderr: diagnostic },
  ]) await assert.rejects(harness(response).run('gh_issue', { action: 'list' }));
});

test('diagnostic can arrive on stdout with CRLF line endings', async () => {
  const h = harness({ code: 1, stdout: diagnostic.replaceAll('\n', '\r\n'), stderr: '' });
  const output = await h.run('gh_issue', { action: 'list' });
  assert.deepEqual(output.data.availableFields, ['comments', 'number', 'title']);
});

test('installed gh parser returns real fields without repo or network access', async t => {
  try {
    await execFileAsync('gh', ['--version']);
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('gh not installed'); return; }
    throw error;
  }
  const h = harness(async (command, args) => {
    try {
      const result = await execFileAsync(command, args, {
        cwd: tmpdir(),
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
        timeout: 5000,
      });
      return { ...result, code: 0 };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  });
  for (const [name, input, field] of [
    ['gh_issue', { action: 'view', comments: true, jq: '.comments' }, 'comments'],
    ['gh_pr', { action: 'checks', watch: true, jq: '.[]' }, 'bucket'],
    ['gh_search', { scope: 'issues', query: '-label:bug', jq: '.[]' }, 'number'],
    ['gh_search', { scope: 'code', query: 'foo' }, 'path'],
    ['gh_run', { action: 'view', log: true }, 'jobs'],
  ]) {
    const output = await h.run(name, input);
    assert.ok(output.data.availableFields.includes(field), `${name}: expected ${field}`);
  }
});
