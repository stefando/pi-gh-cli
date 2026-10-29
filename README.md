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
- **Pre-execution gate.** A `tool_call` handler classifies every call before `gh` runs:
  - reads (`list`/`view`/`checks`/`diff`/`search`/`get`, `gh_api` GET, `gh_search`, `gh_auth_status`) pass freely;
  - mutations, local changes (`checkout`, `update_branch`, downloads/clones), and destructive actions (`delete`) are confirmed in the TUI with the exact tool, action, target, and repo; a decline blocks the call and returns `User declined: ...` to the model.
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

Each tool returns:

- `content[0].text` — formatted stdout (JSON pretty-printed when possible)
- `details.command` — full `gh` argv
- `details.parsed` — parsed JSON if applicable
- `details.actionClass` — `read` | `local_mutation` | `github_mutation` | `destructive`
- `details.warnings` — e.g. missing repo on mutation, unread pagination
- `details.nextSuggested` — hints for follow-up calls
- `details.fullOutputPath` — set when truncated

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
const merged = await tools.gh_pr({ action: "merge", number: "42",
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
