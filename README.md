# DSHACP — Zed-first ACP v1 server for DeepSeek Harness

English | [中文](README.zh.md)

Zed (agent panel, ACP v1 stdio client) → **dshacp** (thin ACP bridge over `dsh-base` + presets) → DSH core services.

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
- **Phase 4 — DSH's own configured surface, inherited**: the process is a thin
  ACP bridge over `dsh-base` + `dsh-agent-presets`, so every DSH tool (skills,
  goals, web_search, subagents, workflow, ralph, plan mode, ask_user_question,
  …) and every configured plugin user-tool is available to the model
- config options in the Zed panel (`session/set_config_option`): **model**,
  **thinking strength**, and **mode** (standard / cordis / code / minimal)
  selectors — switching model resets thinking to that model's default effort;
  a mode switch is allowed only on a blank session (soft-rejected otherwise)
- slash commands: `available_commands_update` over `userInvocable` skills —
  typing `/skill-name` in Zed runs the skill deterministically
- MCP forwarding: Zed's `mcpServers` (stdio + http) are mounted through
  `dsh-mcp-client` and appear as `mcp__<server>__<tool>` tools
- elicitation: `ask_user_question` renders as a form in Zed
  (`session/request_elicitation`), fail-closed on decline/cancel/timeout

Design and implementation plan: [`docs/DESIGN.md`](docs/DESIGN.md).
Research fact sheets: [`ACP-fact-sheet.md`](ACP-fact-sheet.md),
[`docs/zed-acp-integration-fact-sheet.md`](docs/zed-acp-integration-fact-sheet.md),
[`docs/DSH-extension-facts.md`](docs/DSH-extension-facts.md),
[`docs/P4-acp-config-and-dsh-presets.md`](docs/P4-acp-config-and-dsh-presets.md).

## Install

```sh
npm install
npm run build        # tsc → lib/
npm test             # unit + e2e protocol tests (prompt tests need a model key)
```

The bin is `dshacp` (via `npm link` or the package `bin`). It boots a
three-layer composition — the shipped `cordis.yml` (DSHACP-owned rows), the
`dsh-base` bundle patch (the shared host core: registries, sandbox/approval,
persistence, every tool), and the shipped `dshacp.patch.yml` overlay (the
web-app-style disable list that moves the agent-plane tools behind agent
presets) — and reuses `~/.dsh` configuration (credentials, settings,
permission presets, agent presets). No stdout logger, no HMR: stdout carries
JSON-RPC only, diagnostics go to stderr.

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
to that `cwd`, composed from the `standard` agent preset, and persists
sessions under `./.sessions` in the project root (override with
`DSH_SESSIONS_ROOT`). Model, thinking strength, and mode are selectable in the
Zed panel (config options); `default_config_options` in `agent_servers` also
works:

```jsonc
"DSH": {
  "type": "custom",
  "command": "dshacp",
  "args": [],
  "env": {},
  "default_config_options": {
    "model": "deepseek-v4-pro",
    "thought_level": "high"
  }
}
```

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

> Note: like the DSH web app, DSHACP honors `permission.defaultPreset` from
> `~/.dsh/settings.yaml` — a user who configured `danger-full-access` there
> gets unconfined sessions without approval pushes. Override per deployment
> with `DSH_PERMISSION_MODE` or the settings document.

## ACP surface

Client → agent: `initialize`, `session/new`, `session/load`, `session/resume`,
`session/list`, `session/delete`, `session/close`, `session/set_config_option`,
`session/prompt`, `session/cancel` (notification).

Agent → client: `session/request_permission`, `session/request_elicitation`,
`session/update`.

Deliberately not implemented: `authenticate`/`logout` (`authMethods: []`),
`session/set_mode` (config options supersede modes — Zed hides its legacy
selectors whenever `configOptions` is present), `fs/*` and `terminal/*` (DSH
is self-contained; file edits render as tool-call cards, or delegate to Zed's
`fs/write_text_file` in hybrid mode).

## Layout

- `src/bin.ts` — boot entrypoint (`dsh-app-boot`): applies the `dsh-base`
  bundle patch + the shipped `dshacp.patch.yml` overlay over `cordis.yml`
- `src/index.ts` — the DSHACP app plugin: webserver stub + ACP bridge mount
- `src/bridge.ts` — the widened ACP v1 bridge (session records, streaming,
  approval, config options, slash commands, MCP forwarding, elicitation)
- `src/codec.ts` — stopReason / tool-kind / plan / prompt codecs
- `cordis.yml` — the leaf composition: DSHACP-owned rows (agent presets
  roster, ssh, the app)
- `dshacp.patch.yml` — the overlay: web-app-style disable list + DSHACP
  persona + persistence root
- `tests/` — codec units + full e2e protocol tests driven like Zed (official
  `@agentclientprotocol/sdk` client over stdio, isolated `DSH_HOME`)
