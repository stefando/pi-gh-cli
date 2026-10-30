import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { promisify } from 'node:util';
import register from '../extensions/gh-tools.ts';

const execFileAsync = promisify(execFile);

function harness(exec = async () => ({ code: 0, stdout: '[]', stderr: '' })) {
  const tools = new Map();
  const calls = [];
  register({
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {},
    async exec(command, args, options) {
      calls.push({ command, args });
      return exec(command, args, options);
    },
  });
  return {
    calls,
    async search(query, options = {}) {
      return tools.get('gh_search').execute('test', { scope: 'issues', query, ...options }, undefined, undefined, { cwd: tmpdir() });
    },
  };
}

const cases = [
  ['qualifiers and phrases', 'repo:cli/cli is:open "broken feature" label:"help wanted"', ['repo:cli/cli', 'is:open', 'broken feature', 'label:help wanted']],
  ['escaped quotes', String.raw`"say \"hello\"" label:"help \"wanted\""`, ['say "hello"', 'label:help "wanted"']],
  ['literal quotes outside grouping', String.raw`\"hello\"`, ['"hello"']],
  ['escaped and ordinary backslashes', String.raw`path:C:\Users\me "C:\\Program Files\\app"`, ['path:C:\\Users\\me', 'C:\\Program Files\\app']],
  ['trailing backslash', 'path:src\\', ['path:src\\']],
  ['negative quoted qualifier', 'bug -label:"will not fix" -label:wontfix', ['bug', '-label:will not fix', '-label:wontfix']],
  ['boolean grouping', '(repo:o/a OR repo:o/b) AND label:"bug (critical)"', ['(', 'repo:o/a', 'OR', 'repo:o/b', ')', 'AND', 'label:bug (critical)']],
  ['unicode and whitespace', '  "登录 问题"\tlabel:bug\nstate:open\r\n', ['登录 问题', 'label:bug', 'state:open']],
  ['apostrophes are literal', "author:octocat user's", ['author:octocat', "user's"]],
  ['quoted punctuation', '"Note:" "(literal)"', ['Note:', '(literal)']],
  ['no shell expansion', '`whoami` $HOME foo; echo hi', ['`whoami`', '$HOME', 'foo;', 'echo', 'hi']],
];

for (const [name, query, expected] of cases) {
  test(`search tokenizer: ${name}`, async () => {
    const h = harness();
    await h.search(query);
    const args = h.calls[0].args;
    assert.deepEqual(args.slice(args.indexOf('--') + 1), expected);
  });
}

test('flags precede -- and query text cannot become CLI options', async () => {
  const h = harness();
  await h.search('bug -label:wontfix --web --hostname=example.com', { limit: 5, repo: ['o/r'], jq: '.[].number' });
  assert.deepEqual(h.calls[0].args, [
    'search', 'issues', '--limit', '5', '--repo', 'o/r',
    '--json', 'number,title,state,repository,author,labels,updatedAt,url', '--jq', '.[].number',
    '--', 'bug', '-label:wontfix', '--web', '--hostname=example.com',
  ]);
});

test('malformed quotes and empty quoted values reject before executing gh', async () => {
  const h = harness();
  for (const query of ['"broken feature', 'label:"help wanted', String.raw`"trailing \"`, '""', 'label:""', '"   "']) {
    await assert.rejects(h.search(query), /Unmatched double quote|empty quoted/);
  }
  assert.equal(h.calls.length, 0);
});

test('empty query permits flag-only searches', async () => {
  const h = harness();
  await h.search(' \n\t', { owner: ['cli'] });
  assert.deepEqual(h.calls[0].args.slice(-1), ['--']);
  assert.ok(h.calls[0].args.includes('--owner'));
});

test('installed gh reconstructs phrase and qualifier quotes without network or a browser', async t => {
  try {
    await execFileAsync('gh', ['--version']);
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('gh not installed'); return; }
    throw error;
  }
  const h = harness(async (command, args) => {
    // --web serializes the query without an API request. GH_BROWSER=echo prints
    // the URL instead of launching a browser. fields='' suppresses --json below.
    const { stdout, stderr } = await execFileAsync(command, [...args.slice(0, 2), '--web', ...args.slice(2)], {
      cwd: tmpdir(), timeout: 5000,
      env: { ...process.env, GH_HOST: 'github.com', GH_BROWSER: 'echo', GH_TOKEN: 'offline-test-token', GITHUB_TOKEN: '', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    });
    return { stdout, stderr, code: 0 };
  });
  const result = await h.search(String.raw`repo:cli/cli "say \"hello\"" label:"help wanted" -label:wontfix`, { fields: '' });
  const url = new URL(result.structuredContent.text);
  assert.equal(url.host, 'github.com');
  assert.equal(url.searchParams.get('q'), String.raw`repo:cli/cli "say \"hello\"" label:"help wanted" -label:wontfix type:issue`);
});
