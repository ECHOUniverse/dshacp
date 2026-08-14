# DSHACP — Zed-first ACP v1 server for DeepSeek Harness

English | [中文](README.zh.md)

Zed (agent panel, ACP v1 stdio client) → **dshacp** (independent agent spine) → DSH core services.

`dshacp` is a standalone DSH application binary that speaks the **Agent Client
Protocol (ACP) v1 stable** over newline-delimited JSON-RPC stdio, exposing
DSH's full core loop so Zed is a first-class front-end for DSH:

- token-level streaming (`agent_message_chunk` per text delta) and reasoning
  (`agent_thought_chunk`)
- tool calls with inputs/outputs (`tool_call` / `tool_call_update`, ACP `kind`
  mapping)
- plan updates from `todo_write` and cumulative `usage_update`
- approval pushed to the client (`session/request_permission` with
  `allow_once` / `allow_always` / `reject_once`, fail-closed on timeout or
  disconnect; `allow_always` remembers the tool for the session)
- full session management: `session/new`, `session/load` (resume + full
  history replay), `session/resume`, `session/list` (titles from the DSH
  session-title service), `session/delete`, `session/close`, `session/cancel`
- structured delegation visibility: workflow runs and subagent runs render as
  `plan` updates
- remote SSH operations (ssh_list / ssh_exec / ssh_upload / ssh_download /
  ssh_tunnel / ssh_cluster) via the dsh-ssh plugin, sharing `~/.dsh/dsh-ssh.json`
- opt-in hybrid mode (`DSHACP_HYBRID=1`): the `write` tool delegates to Zed's
  `fs/write_text_file` when the client advertises it, so file edits appear as
  per-hunk reviewable diffs

Design and implementation plan: [`docs/DESIGN.md`](docs/DESIGN.md).
Research fact sheets: [`ACP-fact-sheet.md`](ACP-fact-sheet.md),
[`docs/zed-acp-integration-fact-sheet.md`](docs/zed-acp-integration-fact-sheet.md),
[`docs/DSH-extension-facts.md`](docs/DSH-extension-facts.md).

## Install

```sh
npm install
npm run build        # tsc → lib/
npm test             # unit + e2e protocol tests (prompt tests need a model key)
```

The bin is `dshacp` (via `npm link` or the package `bin`). It boots its own
`cordis.yml` composition — agent spine (llm, sandbox, tools, approval,
subagent, workflow), JSONL session persistence, and the ACP bridge — and
reuses `~/.dsh` configuration (credentials, settings). No stdout logger, no
HMR: stdout carries JSON-RPC only, diagnostics go to stderr.

## Zed configuration

`settings.json` → AI → External Agents → Add Custom Agent:

```jsonc
{
  "agent_servers": {
    "DSH": {
      "type": "custom",   // REQUIRED
      "command": "dshacp",
      "args": [],
      "env": {}           // keys come from ~/.dsh, not here
    }
  }
}
```

Zed spawns `dshacp` with `cwd` = the project root and speaks line-delimited
JSON-RPC over stdio. The server creates one DSH agent per ACP session, scoped
to that `cwd`, and persists sessions under `./.sessions` in the project root
(override with `DSH_SESSIONS_ROOT`).

Credentials: the DeepSeek adapter reads `DEEPSEEK_API_KEY` from
`~/.dsh/.credentials.yaml` (or the environment). Zed injects no keys for
custom agents.

### Environment knobs

| Variable | Effect |
|---|---|
| `DSH_SESSIONS_ROOT` | Session persistence directory (default `./.sessions`) |
| `DSH_PERMISSION_MODE` | `workspace-write` (default) or `danger-full-access` (approval policy becomes `never`) |
| `DEEPSEEK_API_KEY` | API key when not in `~/.dsh/.credentials.yaml` |
| `DSHACP_HYBRID` | `1` enables P3 hybrid mode: `write` delegates to the client's `fs/write_text_file` (Zed diff review) when the client advertises the capability |

## ACP surface

Client → agent: `initialize`, `session/new`, `session/load`, `session/resume`,
`session/list`, `session/delete`, `session/close`, `session/prompt`,
`session/cancel` (notification).

Agent → client: `session/request_permission`, `session/update`.

Deliberately not implemented: `authenticate`/`logout` (`authMethods: []`),
`session/set_mode` (no modes advertised), `fs/*` and `terminal/*` (DSH is
self-contained; file edits render as tool-call cards).

## Layout

- `src/bin.ts` — boot entrypoint (`dsh-app-boot`), defaults to the shipped `cordis.yml`
- `src/index.ts` — app composition: agent spine + persistence + bridge
- `src/bridge.ts` — the widened ACP v1 bridge (session records, streaming, approval)
- `src/codec.ts` — stopReason / tool-kind / plan / prompt codecs
- `cordis.yml` — deployment composition (adapter, sandbox, approval, subagent,
  workflow, fs, todo, persistence)
- `tests/` — codec units + full e2e protocol tests driven like Zed (official
  `@agentclientprotocol/sdk` client over stdio)
