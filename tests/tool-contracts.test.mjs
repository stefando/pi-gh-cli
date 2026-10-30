import assert from 'node:assert/strict';
import test from 'node:test';
import { Compile } from 'typebox/compile';
import register from '../extensions/gh-tools.ts';

function harness({ allow = true } = {}) {
  const tools = new Map();
  let gate;
  const calls = [];
  const prompts = [];
  const ctx = {
    cwd: process.cwd(), hasUI: true,
    ui: { async confirm(title, message) { prompts.push({ title, message }); return allow; } },
  };
  register({
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { if (name === 'tool_call') gate = handler; },
    async exec(command, args) { calls.push({ command, args }); return { code: 0, stdout: '[]', stderr: '' }; },
  });
  return {
    tools, calls, prompts,
    async run(name, input, { nested = false } = {}) {
      const tool = tools.get(name);
      assert.ok(Compile(tool.parameters).Check(input), `valid input for ${name}`);
      const decision = await gate({ toolName: name, input, ...(nested ? { parentToolCallId: 'codemode/1' } : {}) }, ctx);
      if (decision?.block) return { blocked: true, reason: decision.reason };
      const result = await tool.execute('test', input, undefined, undefined, ctx);
      assert.ok(Compile(tool.outputSchema).Check(result.structuredContent));
      return result.structuredContent;
    },
  };
}

test('all tools retain codemode exposure, shared namespace and discovery guidance', () => {
  const h = harness();
  assert.equal(h.tools.size, 13);
  const namespace = h.tools.get('gh_issue').namespace;
  assert.equal(namespace.name, 'gh');
  assert.ok(namespace.aliases.includes('github'));
  assert.match(namespace.instructions, /result\.data/);
  for (const tool of h.tools.values()) {
    assert.equal(tool.exposure, 'codemode', tool.name);
    assert.equal(tool.namespace, namespace, tool.name);
    assert.ok(tool.outputSchema, tool.name);
    assert.equal(Object.hasOwn(tool.parameters.properties, 'confirm'), false, tool.name);
  }
  assert.equal(h.tools.get('gh_search').annotations.readOnlyHint, true);
  assert.equal(h.tools.get('gh_auth_status').annotations.readOnlyHint, true);
});

for (const name of ['gh_issue', 'gh_pr']) {
  test(`${name} view comments remain JSON for explicit and default fields`, async () => {
    const h = harness();
    for (const [fields, comments, expected] of [
      ['number,title', true, 'number,title,comments'],
      ['number,comments', true, 'number,comments'],
      ['number,title', false, 'number,title'],
    ]) {
      await h.run(name, { action: 'view', number: '42', fields, comments, jq: '.comments' });
      const { args } = h.calls.at(-1);
      assert.equal(args[args.indexOf('--json') + 1], expected);
      assert.equal(args.includes('--comments'), false);
      assert.equal(args[args.indexOf('--jq') + 1], '.comments');
    }
    await h.run(name, { action: 'view', number: '42', comments: true });
    const { args } = h.calls.at(-1);
    assert.ok(args[args.indexOf('--json') + 1].split(',').includes('comments'));
    assert.equal(args.includes('--comments'), false);
    assert.equal(h.prompts.length, 0);
  });
}

test('jq is forwarded on supported JSON branches, not plain-text branches', async () => {
  const h = harness();
  for (const [name, input] of [
    ['gh_issue', { action: 'list' }], ['gh_pr', { action: 'list' }],
    ['gh_pr', { action: 'checks', number: '42' }], ['gh_repo', { action: 'view' }],
    ['gh_repo', { action: 'list' }], ['gh_run', { action: 'list' }],
    ['gh_run', { action: 'view', runId: '1' }], ['gh_workflow', { action: 'list' }],
    ['gh_release', { action: 'list' }], ['gh_release', { action: 'view' }],
    ['gh_label', { action: 'list' }], ['gh_search', { scope: 'issues', query: 'bug' }],
  ]) {
    await h.run(name, { ...input, jq: '.' });
    const { args } = h.calls.at(-1);
    assert.ok(args.includes('--json'), name);
    assert.equal(args[args.indexOf('--jq') + 1], '.', name);
  }
  for (const [name, input] of [
    ['gh_pr', { action: 'diff', number: '42' }],
    ['gh_pr', { action: 'checks', number: '42', watch: true }],
    ['gh_run', { action: 'view', runId: '1', log: true }],
  ]) {
    await h.run(name, { ...input, jq: '.' });
    assert.equal(h.calls.at(-1).args.includes('--jq'), false, name);
  }
});

test('denial prevents execution for direct and nested event shapes', async () => {
  for (const nested of [false, true]) {
    const h = harness({ allow: false });
    const result = await h.run('gh_pr', { action: 'merge', repo: 'o/r', number: '42', mergeMethod: 'squash' }, { nested });
    assert.equal(result.blocked, true);
    assert.match(result.reason, /User declined/);
    assert.equal(h.prompts.length, 1);
    assert.equal(h.calls.length, 0);
  }
});

test('approval runs the exact mutation once and retains the final result contract', async () => {
  const h = harness();
  const result = await h.run('gh_pr', { action: 'merge', repo: 'o/r', number: '42', mergeMethod: 'squash', matchHeadCommit: 'abc', deleteBranch: true }, { nested: true });
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(h.calls, [{ command: 'gh', args: ['pr', 'merge', '--repo', 'o/r', '42', '--squash', '--delete-branch', '--match-head-commit', 'abc'] }]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.actionClass, 'github_mutation');
});

test('ambiguous mutation never reaches approval or execution', async () => {
  const h = harness();
  const result = await h.run('gh_issue', { action: 'close', number: '42' });
  assert.equal(result.blocked, true);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.calls.length, 0);
});

test('body text is one literal argv value and bodyFile has its own flag', async () => {
  const h = harness();
  const body = 'Quotes: "hello"; `whoami` $(echo nope)\nsecond line';
  await h.run('gh_issue', { action: 'comment', repo: 'o/r', number: '42', body });
  assert.deepEqual(h.calls.at(-1).args, ['issue', 'comment', '--repo', 'o/r', '42', '--body', body]);
  await h.run('gh_issue', { action: 'comment', repo: 'o/r', number: '42', bodyFile: '/tmp/body with spaces.md' });
  assert.deepEqual(h.calls.at(-1).args, ['issue', 'comment', '--repo', 'o/r', '42', '--body-file', '/tmp/body with spaces.md']);
  const before = h.calls.length;
  await assert.rejects(h.run('gh_issue', { action: 'comment', repo: 'o/r', number: '42', body, bodyFile: '/tmp/body.md' }), /either body or bodyFile/);
  assert.equal(h.calls.length, before);
});

test('ordinary list below the limit does not claim truncation', async () => {
  const h = harness();
  const result = await h.run('gh_issue', { action: 'list', limit: 30 });
  assert.equal(result.truncated, false);
  assert.deepEqual(result.warnings, []);
});
