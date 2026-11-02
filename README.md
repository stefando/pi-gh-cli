# pi-gh-cli — personal fork

> **Personal use only.** This is [stefando's fork](https://github.com/stefando/pi-gh-cli) of [tianrendong/pi-gh-cli](https://github.com/tianrendong/pi-gh-cli), modified for a personal pi setup. There is **no intention to publish this fork to npm or maintain it as a supported project**. No ongoing maintenance, updates, support, or compatibility guarantees are offered. The original MIT license is preserved.

Structured GitHub CLI (`gh`) tools for Pi agents, exposed through **codemode** with a pre-execution confirmation **gate** for mutations.

## Install from this fork

If the original npm extension is installed, remove it first to avoid loading both versions:

```bash
pi remove npm:pi-gh-cli
pi install git:github.com/stefando/pi-gh-cli@dev/gummi/gh-codemode
```

Restart pi after replacing the installation. Confirm the configured source with `pi list`. Codemode must be enabled; for one session, use `pi --tools +codemode`.

Or try without installing:

```bash
pi -e git:github.com/stefando/pi-gh-cli@dev/gummi/gh-codemode
```

Requires pi 1.5+, GitHub CLI (`gh auth login`) and [codemode enabled](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/cli.md#enable-codemode) — the tools are registered with `codemode` exposure, so the model reaches them from codemode scripts rather than as declared tools.

## How it works

- **Near-zero context cost.** The 13 tools are not declared in the system prompt. They are listed under the `gh` namespace in the codemode description and discoverable via `searchTools()` / `describeTool()` / `describeNamespace("gh")`.
- **Called from scripts.** `await tools.gh_pr({ action: "view", number: "42" })`. Independent calls can run in parallel with `Promise.all`.
- **Validation and safe argv.** Arguments are validated as JSON Schema built with TypeBox and built into `gh` arg arrays — no shell quoting, no interactive prompts (`GH_PROMPT_DISABLED=1`, required flags enforced).
- **Output shaping.** Every `--json` command accepts `jq` (applied by gh before output reaches context) and `fields`; pass `fields='*'` to list all available fields for a command. List results that come back exactly at `limit` get a truncation warning, since gh caps lists silently.
- **Search queries** use gh's token model: qualifiers as separate tokens (`repo:cli/cli is:open`), double quotes group phrases and multi-word qualifier values (`"broken feature"`, `label:"help wanted"`), negative qualifiers work (`-label:wontfix`); tokens are appended after `--` so they can never be parsed as flags. A state-machine tokenizer handles escaping and rejects malformed quotes before executing gh.
- **Pre-execution gate.** A `tool_call` handler classifies every call before `gh` runs:
  - reads (`list`/`view`/`checks`/`diff`/`search`/`get`, `gh_api` GET, `gh_search`, `gh_auth_status`) pass freely;
  - mutations, local changes (`checkout`, `update_branch`, downloads/clones), and destructive actions (`delete`) require confirmation with scope and options (review verdict, merge flags, visibility, workflow inputs, file destinations, etc.); a decline blocks the call. Without a confirmation UI, mutations are blocked.
  - repository mutations require `repo=OWNER/REPO` (or `HOST/OWNER/REPO`); issue/PR mutations require a numeric `number`, not a branch or URL. Repo creation requires `name=OWNER/REPO`. Organization/environment secrets and variables require an explicit scope and org/env. API mutations require literal endpoints without cwd-dependent placeholders.
  - confirmation dialogs redact bodies, notes, API payloads and headers. Inspect those separately before approving; the dialog is not a payload review.
  - classification fails closed: an unknown action is treated as a mutation.
  - the gate fires for nested (codemode-script) calls too, since they go through the same `tool_call` handler.

## Tools (namespace `gh`)

- `gh_issue` — list/view/create/comment/edit/close/reopen issues
- `gh_pr` — list/view/checks/diff/create/comment/review/merge/close/reopen/ready/checkout/update_branch PRs
- `gh_repo` — view/list/default/create/edit repositories
- `gh_run` — list/view/watch/rerun/cancel/download GitHub Actions runs
- `gh_workflow` — list/view/run/enable/disable workflows
- `gh_release` — list/view/create/edit/delete/upload/download releases
- `gh_label` — list/create/edit/delete/clone labels
- `gh_search` — repos/issues/prs/code/commits search
- `gh_secret` — list/set/delete Actions/Codespaces/Dependabot secrets
- `gh_variable` — list/get/set/delete Actions variables
- `gh_gist` — list/view/create/edit/delete/clone gists
- `gh_api` — escape-hatch authenticated `gh api` requests (REST + GraphQL)
- `gh_auth_status` — read-only auth check, never shows tokens

## Result envelope

All tools declare an output schema. **Codemode calls resolve to an object**, not a JSON string:

```js
const result = await tools.gh_pr({ action: "list", repo: "OWNER/REPO", fields: "number,title" });
if (result.truncated) {
  text({ text: result.text, fullOutputPath: result.fullOutputPath });
} else {
  text(result.data);
}
text(result.warnings);
```

The object contains:

- `data` — parsed JSON (including scalars and `null`), only when the output is complete JSON.
- `text` — bounded output when JSON is unavailable or truncated. JSON is not duplicated into this field when `data` is present.
- `exitCode` — process exit code. Ordinary command failures reject the call; `gh_auth_status` intentionally returns nonzero status here instead of throwing. Field discovery also returns gh's expected diagnostic exit code, `1`.
- `actionClass` — `read` | `local_mutation` | `github_mutation` | `destructive`.
- `warnings` — advisory strings, including possible list caps and API pagination warnings.
- `nextSuggested` — hints for follow-up calls.
- `truncated` — whether stdout was truncated. If true, `data` is omitted so full JSON cannot bypass the output limit.
- `fullOutputPath` — path to complete stdout when truncated.
- `stderr` — bounded stderr, when present.

Direct calls still return formatted `content[0].text`, with warnings and hints appended, and rendering metadata in `details`. Raw argv is not included in the codemode object because it can contain sensitive arguments.

### Search-query notation

`query` is not a shell command. Double quotes group text into a single gh argument; gh then quotes that argument when building its search string. Use `\"` for a literal double quote and `\\` for a literal backslash. Other backslashes are preserved. Single quotes and shell expressions are literal text, not shell quoting or expansion.

```js
await tools.gh_search({
  scope: "issues",
  query: String.raw`repo:cli/cli "say \"hello\"" label:"help wanted" -label:wontfix`,
});
```

Unquoted parentheses become separate grouping tokens, so `(repo:o/a OR repo:o/b)` works with gh's advanced issue search. Quotes must be balanced, and empty quoted terms/qualifier values are rejected rather than silently changed. An empty or whitespace-only query can be used for flag-only searches (for example, with `owner`). This notation does not validate every GitHub search-language rule; gh and GitHub still enforce those.

### Discovering JSON fields

Use `fields: "*"` on a supported read command:

```js
const result = await tools.gh_issue({ action: "view", fields: "*" });
text(result.data.availableFields);
```

Discovery runs only `gh <resource> <action> --json`, locally. It ignores `jq`, comments, search queries, targets, and other operation options so they cannot interfere with parsing. No repository or issue/PR target is needed. The expected field-list diagnostic (gh exit code `1`) becomes a structured result; other errors still reject.

Supported commands: issue list/view; PR list/view/checks; repo list/view; run list/view; workflow list; release list/view; label list; and all five search scopes, including code. Mutation commands and commands without JSON support (including `gist list` in the installed gh) reject discovery without executing the operation.

## Safety

- Argument arrays, no shell quoting.
- Defaults to `gh --json` fields where available; pass `fields=` to override.
- Tools never block on interactive prompts; the user-facing confirmation happens pre-execution in the gate, not inside the tool.
- Prompt-prone actions validate required args or pass blank bodies/notes rather than opening editors.
- Destructive actions (`delete`) auto-pass `--yes`; the gate confirms them first.
- Each `gh` process has a bounded timeout. Full output saved to a temp file when truncated.
- Bodies/notes/secrets accept `bodyFile` / `notesFile` to avoid shell quoting and accidental logging.
- The gate confirms mutations but does not verify intent: passing the wrong `repo` is still possible, so pass `repo=OWNER/REPO` explicitly for mutations.

## Agent usage patterns

From a codemode script, read before write:

```js
const pr = await tools.gh_pr({ action: "view", number: "42",
  fields: "number,title,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,headRefOid" });
// decide based on returned state; the merge will trigger the user confirmation gate
const merged = await tools.gh_pr({ action: "merge", repo: "OWNER/REPO", number: "42",
  mergeMethod: "squash", matchHeadCommit: "<headRefOid>" });
```

Always pass `repo=OWNER/REPO` for mutations to avoid current-directory inference.

For endpoints not covered, use `gh_api`. Prefer the typed tool when available.

## Examples

Ask Pi:

> List open PRs in this repo

> Show failed logs for latest failing Actions run

> Comment on issue #123 with this summary

For GitHub endpoints not covered by the specific tools, use `gh_api`.

## Development

For local development, use Node **22.19.0+** (pi's minimum), then run `npm install --ignore-scripts`, `npm run check`, and `npm test`. No build or npm publishing is required; install this fork directly from GitHub using the command above.

The tests cover registration, mutation gating, argv construction, structured results, truncation, field discovery, and search tokenization. Gate/execution tests mock the pi API and UI. Two offline tests exercise the installed gh parser/query serializer without API calls, browser launches, or real credentials; they skip if gh is absent.
