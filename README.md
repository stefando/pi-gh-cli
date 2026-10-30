# pi-gh-cli

Structured GitHub CLI (`gh`) tools for Pi agents, exposed through **codemode** with a pre-execution confirmation **gate** for mutations.

## Install

```bash
pi install npm:pi-gh-cli
```

Or try without installing:

```bash
pi -e npm:pi-gh-cli
```

Requires GitHub CLI (`gh auth login`) and [codemode enabled](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/cli.md#enable-codemode) — the tools are registered with `codemode` exposure, so the model reaches them from codemode scripts rather than as declared tools.

## How it works

- **Near-zero context cost.** The 13 tools are not declared in the system prompt. They are listed under the `gh` namespace in the codemode description and discoverable via `searchTools()` / `describeTool()` / `describeNamespace("gh")`.
- **Called from scripts.** `await tools.gh_pr({ action: "view", number: "42" })`. Independent calls can run in parallel with `Promise.all`.
- **Validation and safe argv.** Arguments are validated against TypeBox schemas and built into `gh` arg arrays — no shell quoting, no interactive prompts (`GH_PROMPT_DISABLED=1`, required flags enforced).
- **Output shaping.** Every `--json` command accepts `jq` (applied by gh before output reaches context) and `fields`; pass `fields='*'` to list all available fields for a command. List results that come back exactly at `limit` get a truncation warning, since gh caps lists silently.
- **Search queries** use gh's token model: qualifiers as separate tokens (`repo:cli/cli is:open`), double quotes mark phrases and multi-word qualifier values (`"broken feature"`, `label:"help wanted"`), negative qualifiers work (`-label:wontfix`); tokens are appended after `--` so they can never be parsed as flags.
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
- `exitCode` — process exit code. Ordinary command failures reject the call; `gh_auth_status` intentionally returns nonzero status here instead of throwing.
- `actionClass` — `read` | `local_mutation` | `github_mutation` | `destructive`.
- `warnings` — advisory strings, including possible list caps and API pagination warnings.
- `nextSuggested` — hints for follow-up calls.
- `truncated` — whether stdout was truncated. If true, `data` is omitted so full JSON cannot bypass the output limit.
- `fullOutputPath` — path to complete stdout when truncated.
- `stderr` — bounded stderr, when present.

Direct calls still return formatted `content[0].text`, with warnings and hints appended, and rendering metadata in `details`. Raw argv is not included in the codemode object because it can contain sensitive arguments.

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

Run `npm run check` and `npm test`. The tests use Node's native TypeScript support (Node 22.18+ or a newer supported release). Gate tests use a mocked pi UI and do not execute GitHub mutations.
