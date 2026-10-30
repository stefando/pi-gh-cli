import assert from 'node:assert/strict';
import test from 'node:test';
import register from '../extensions/gh-tools.ts';

function harness({ allow = true, hasUI = true } = {}) {
  let gate;
  const prompts = [];
  const tools = new Map();
  const controller = new AbortController();
  register({
    registerTool(tool) { tools.set(tool.name, tool); },
    on(event, handler) { if (event === 'tool_call') gate = handler; },
  });
  const ctx = {
    hasUI,
    signal: controller.signal,
    ui: { async confirm(title, message, options) {
      prompts.push({ title, message, options });
      return allow;
    } },
  };
  return {
    prompts, ctx,
    call(toolName, input, nested = false) {
      return gate({ toolName, input, ...(nested ? { parentToolCallId: 'codemode/1' } : {}) }, ctx);
    },
  };
}

test('reads and unrelated tools never prompt', async () => {
  const h = harness();
  for (const [name, input] of [
    ['gh_pr', { action: 'view' }], ['gh_issue', { action: 'list' }],
    ['gh_search', { scope: 'issues', query: 'bug' }], ['gh_auth_status', {}],
    ['gh_api', { endpoint: 'repos/o/r/issues' }], ['gh_run', { action: 'watch', runId: '1' }],
    ['gh_repo', { action: 'default' }], ['gh_custom', { action: 'delete' }],
    ['bash', { command: 'echo test' }],
  ]) assert.equal(await h.call(name, input), undefined);
  assert.equal(h.prompts.length, 0);
});

test('review dialogs distinguish approve, request changes, and default comment', async () => {
  const h = harness();
  for (const review of ['approve', 'request_changes', undefined]) {
    assert.equal(await h.call('gh_pr', { action: 'review', repo: 'o/r', number: '42', review }), undefined);
  }
  assert.match(h.prompts[0].message, /"review": "approve"/);
  assert.match(h.prompts[1].message, /"review": "request_changes"/);
  assert.match(h.prompts[2].message, /comment \(default\)/);
});

test('merge dialog includes consequential flags and abort signal', async () => {
  const h = harness();
  await h.call('gh_pr', { action: 'merge', repo: 'o/r', number: '42', mergeMethod: 'squash', admin: true, deleteBranch: true, matchHeadCommit: 'abc' });
  for (const fragment of ['o/r', '42', 'squash', 'admin', 'deleteBranch', 'abc']) assert.ok(h.prompts[0].message.includes(fragment));
  assert.equal(h.prompts[0].options.signal, h.ctx.signal);
});

test('organization and environment scope is explicit and secret body never appears', async () => {
  const h = harness();
  await h.call('gh_secret', { action: 'set', scope: 'organization', org: 'my-org', name: 'KEY', body: 'VERY_SECRET', visibility: 'selected', repos: ['r'] });
  assert.match(h.prompts[0].message, /Organization: my-org/);
  assert.match(h.prompts[0].message, /visibility/);
  assert.doesNotMatch(h.prompts[0].message, /VERY_SECRET|current repo/);
  await h.call('gh_variable', { action: 'set', scope: 'environment', repo: 'o/r', env: 'production', name: 'KEY', bodyFile: '/tmp/value' });
  assert.match(h.prompts[1].message, /Repository: o\/r; environment: production/);
  assert.match(h.prompts[1].message, /\/tmp\/value/);
});

test('ambiguous targets are blocked before asking for approval', async () => {
  const h = harness();
  for (const [name, input] of [
    ['gh_pr', { action: 'merge', number: '42' }],
    ['gh_pr', { action: 'merge', repo: 'o/r' }],
    ['gh_issue', { action: 'close', repo: 'o/r', number: 'https://github.com/other/repo/issues/42' }],
    ['gh_repo', { action: 'create', name: 'unqualified', visibility: 'private' }],
    ['gh_secret', { action: 'set', scope: 'organization', name: 'KEY' }],
    ['gh_variable', { action: 'set', scope: 'environment', repo: 'o/r', name: 'KEY' }],
    ['gh_secret', { action: 'set', org: 'ignored-org', repo: 'o/r', name: 'KEY' }],
    ['gh_variable', { action: 'set', env: 'ignored-env', repo: 'o/r', name: 'KEY' }],
    ['gh_secret', { action: 'set', scope: 'organization', org: 'org', repo: 'o/r', name: 'KEY' }],
    ['gh_api', { method: 'POST', endpoint: 'repos/{owner}/{repo}/issues' }],
  ]) {
    const result = await h.call(name, input);
    assert.equal(result?.block, true, JSON.stringify([name, input]));
  }
  assert.equal(h.prompts.length, 0);
});

test('API dialog shows host and endpoint but not payload or header values', async () => {
  const h = harness();
  await h.call('gh_api', { method: 'POST', hostname: 'git.example.com', endpoint: 'repos/o/r/issues', rawField: [{ key: 'body', value: 'SECRET_PAYLOAD' }], header: [{ key: 'Authorization', value: 'SECRET_TOKEN' }] });
  assert.match(h.prompts[0].message, /API host: git.example.com; endpoint: repos\/o\/r\/issues/);
  assert.doesNotMatch(h.prompts[0].message, /SECRET_PAYLOAD|SECRET_TOKEN/);
});

test('workflow, repository edits and local writes show their options', async () => {
  const h = harness();
  await h.call('gh_workflow', { action: 'run', repo: 'o/r', workflow: 'deploy.yml', ref: 'main', field: [{ key: 'stage', value: 'production' }] });
  assert.match(h.prompts[0].message, /deploy.yml/);
  assert.match(h.prompts[0].message, /production/);
  await h.call('gh_repo', { action: 'edit', repo: 'o/r', visibility: 'public' });
  assert.match(h.prompts[1].message, /"visibility": "public"/);
  await h.call('gh_release', { action: 'download', repo: 'o/r', tag: 'v1', dir: '/tmp/out', clobber: true });
  assert.match(h.prompts[2].message, /\/tmp\/out/);
  assert.match(h.prompts[2].message, /"clobber": true/);
});

test('declined nested calls and headless mutations are blocked', async () => {
  const input = { action: 'delete', repo: 'o/r', name: 'bug' };
  const h = harness({ allow: false });
  const denied = await h.call('gh_label', input, true);
  assert.equal(denied.block, true);
  assert.match(denied.reason, /User declined/);
  assert.equal(h.prompts[0].title, 'Destructive GitHub operation');
  const headless = harness({ hasUI: false });
  assert.equal((await headless.call('gh_label', input)).block, true);
  assert.equal(headless.prompts.length, 0);
});

test('unknown actions fail closed and gist scope is not described as a repository', async () => {
  const h = harness({ allow: false });
  assert.equal((await h.call('gh_pr', { action: 'future', repo: 'o/r', number: '42' })).block, true);
  await h.call('gh_gist', { action: 'delete', id: 'abc' });
  assert.match(h.prompts[1].message, /authenticated account \(not a repository\)/);
});
