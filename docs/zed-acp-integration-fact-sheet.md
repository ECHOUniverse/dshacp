# Zed Editor × ACP (Agent Client Protocol) — Integration Fact Sheet

Research compiled from primary sources only: zed.dev docs, zed-industries/zed source (HEAD), the
ACP spec (agentclientprotocol.com, github.com/agentclientprotocol/agent-client-protocol),
qwen-code docs, and the READMEs of claude-code-acp / codex-acp / @aicoach/acp. Facts were
verified against source code, not secondary write-ups.

---

## 1. The Agent Panel and how a user adds a custom (third-party) agent

- The **Agent Panel** is Zed's AI coding surface ("core of Zed's AI code editing experience"): open with `agent: new thread` (Command Palette) or the ✨ status-bar icon. It hosts Zed Agent threads **and** External Agent threads. — https://zed.dev/docs/ai/agent-panel
- **External Agents** are agents that integrate through ACP: "Zed hosts the thread in the Agent Panel and Threads Sidebar, while the External Agent usually owns its own runtime, auth, model selection, tools, and native configuration." Zed does not charge for them and "nothing touches our servers." — https://zed.dev/docs/ai/external-agents and https://zed.dev/blog/bring-your-own-agent-to-zed
- Two ways to add a third-party agent (Settings Editor → **AI → External Agents** page, `agent: open settings`):
  1. **Install from the ACP Registry** (primary path; open with `zed: acp registry`): curated list including Claude, Codex, OpenCode, Copilot, Cursor, Pi (non-exhaustive). — https://zed.dev/docs/ai/external-agents#registry and https://zed.dev/blog/acp-registry
  2. **Add Custom Agent**: "Zed opens your settings file with an `agent_servers` entry" — you write the JSON yourself. — https://zed.dev/docs/ai/external-agents#custom-agents
- After install, the agent appears in the new-thread menu in the Agent Panel and Threads Sidebar; `agent: new external agent thread` creates a thread for a specific agent id. — https://zed.dev/docs/ai/agent-panel
- Extension-provided agents are **deprecated** and auto-migrated to registry equivalents. — https://zed.dev/docs/ai/external-agents#extension-agents
- Background: ACP was created by Zed (with Google/Gemini CLI as reference implementation), announced 2025-08-27; Zed's own in-process agent was rewritten to use the same ACP code paths/UI as third-party agents. — https://zed.dev/blog/bring-your-own-agent-to-zed

## 2. Exact configuration format: `agent_servers` in `settings.json`

**It is a key in Zed's `settings.json` — not a `~/.zed/agent.json` file, not a standalone JSON schema** (a JSON schema for settings validation is generated from Rust `JsonSchema` derives, but the user-facing format is the settings file; edit it via `zed: open settings file` / `agent: open settings`). — https://zed.dev/docs/ai/agent-settings

Canonical example, verbatim from the Zed docs:
```json
{
  "agent_servers": {
    "my-agent": {
      "type": "custom",
      "command": "node",
      "args": ["~/projects/agent/index.js", "--acp"],
      "env": {}
    }
  }
}
```
— https://zed.dev/docs/ai/external-agents#custom-agents

Exact schema from source (`crates/settings_content/src/agent.rs`, `CustomAgentServerSettings`):
- `#[serde(tag = "type", rename_all = "snake_case")]` — discriminator is `"type"` with variants `Custom` and `Registry` (alias `"extension"` for migration).
- **`Custom`** fields (JSON keys): `command` (string; `PathBuf`, `~` is expanded via `shellexpand::tilde` — `crates/project/src/agent_server_store.rs`), `args` (string array), `env` (object), plus `default_mode`, `default_config_options` (map of option-id → string-or-bool), `favorite_config_option_values` (map of option-id → array of value-ids).
- **`Registry`** fields: `env`, `default_mode`, `default_config_options`, `favorite_config_option_values` (used for per-agent overrides of registry-installed agents).
- Top level is `AllAgentServersSettings(HashMap<String, CustomAgentServerSettings>)`, serde-transparent, mounted as the `agent_servers` settings key (`crates/settings_content/src/settings_content.rs`).

Real third-party examples:
- **Qwen Code** (manual install, from qwen-code's official Zed docs): `"Qwen Code": { "type": "custom", "command": "qwen", "args": ["--acp"], "env": {} }` — https://qwenlm.github.io/qwen-code-docs/en/users/integration-zed/
- **claude-code-acp** (`cc-acp`): `"Claude Code": { "command": "cc-acp", "args": [], "env": {} }` (optionally `env: { "CLAUDE_API_KEY": "sk-ant-..." }`); note this README omits `"type"` — the current Zed docs always include `"type": "custom"` — https://github.com/carlrannaberg/cc-acp (npm `claude-code-acp`, installs the `cc-acp` command)

Registry-installed agents can also have per-agent settings under `agent_servers.<agent-id>` (docs), and the registry itself defines package/args/env per agent (`RegistryNpxAgent { package, args, env }` in `crates/project/src/agent_server_store.rs`).

## 3. How Zed launches the agent

**Yes — a stdio subprocess.** `AcpConnection::stdio(...)` (`crates/agent_servers/src/acp.rs`):
1. Resolves the project **root** = first ordered path of the project's path list (`default_path_list().ordered_paths().next()`).
2. Builds the command with a system-shell `ShellBuilder` (non-interactive), sets `envs(env)`, and — for **local projects** — `child.current_dir(cwd)` where cwd is the project root. **Remote projects** instead run the command through `remote_client().build_command(...)` (executed on the remote host).
3. Spawns with **stdin/stdout/stderr all piped**, and speaks **line-delimited JSON-RPC** over stdio (`Lines` transport); stderr is captured to the ACP debug log.

**Environment** passed to the subprocess (merged in `LocalCustomAgent::get_command`, `crates/project/src/agent_server_store.rs` + `crates/agent_servers/src/custom.rs`):
1. `project_environment.default_environment()` — if Zed was launched from the CLI, the inherited CLI env; otherwise a shell is spawned in the project dir to load env "as if the user had cd'd there" (including direnv `.envrc` if enabled) — `crates/project/src/environment.rs`.
2. `agent_servers.<id>.env` from settings (the user's own env block).
3. Zed-injected extras: proxy vars `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` from Zed's proxy settings; `NO_BROWSER=1` when the `no_browser` setting is on.

**API keys:** Zed does **not** provision keys for plain custom agents — agents own their auth (see §8). Key injection exists only for specific registry agents (Gemini/Claude/Codex special-cases).

## 4. ACP version supported: **v1 (stable)**; v2 is a draft

- Zed's workspace pins `agent-client-protocol = { version = "=2.0.0", features = ["unstable"] }` (`Cargo.toml` in zed-industries/zed).
- The crate is authored by Zed; **its 2.0.0 changelog explicitly says "Version 2.0 keeps the stable ACP v1 wire schema unchanged"** (2.0.0 is an SDK-API version, not a protocol version) — https://crates.io/crates/agent-client-protocol
- Zed's code imports `agent_client_protocol::schema::v1 as acp` everywhere (`crates/acp_thread/src/connection.rs`, `crates/acp_thread/src/acp_thread.rs`, `crates/agent_servers/src/agent_servers.rs`). So Zed implements **ACP v1 stable**.
- The `unstable` feature Zed enables = `unstable_auth_methods, unstable_elicitation, unstable_end_turn_token_usage, unstable_mcp_over_acp, unstable_session_fork` (extra **v1** extensions).
- **ACP v2 is a separate protocol version in Draft**: "The ACP v2 protocol documentation and schema are now published in Draft form" (announcement published 2026-07-20, https://agentclientprotocol.com/announcements/acp-v2-draft). Its schema (`schema::v2`) is gated behind the `unstable_protocol_v2` feature, **which Zed does not enable**.
- Protocol transport: local agents are sub-processes of the editor communicating via JSON-RPC over stdio; remote agents over HTTP/WebSocket (remote support "a work in progress"). — https://agentclientprotocol.com/get-started/introduction
- Spec governance: spec repo https://github.com/agentclientprotocol/agent-client-protocol (Apache-2.0), Rust SDK https://github.com/agentclientprotocol/rust-sdk.

## 5. Client capabilities Zed advertises; agent capabilities Zed expects

**Zed's `ClientCapabilities`** (built in `client_capabilities_for_agent()`, `crates/agent_servers/src/acp.rs`):
- `fs: FileSystemCapabilities { read_text_file: true, write_text_file: true }`
- `terminal: true`
- `auth: AuthCapabilities { terminal: true }` (Zed can host terminal-based sign-in; sends meta `terminal-auth`)
- `session: ClientSessionCapabilities { config_options { boolean } }`
- `elicitation: { form, url }`
- meta: `terminal_output: true`, `terminal-auth: true` (+ `parameterized_model_picker` for Cursor)

**Agent capabilities Zed consumes** (ACP v1 `AgentCapabilities`, `crates/acp_thread/src/connection.rs` trait + schema `agent-client-protocol-schema/src/v1/agent.rs`):
- `load_session`, `session_capabilities` (`resume`/`close`/`list`/`delete`), `mcp_capabilities` (`http`/`sse`/stdio), `auth` (auth methods + logout), `prompt_capabilities` (`image`, `audio`, `embedded_context`).
- Zed's `AgentConnection` trait: `supports_load_session/resume/session_history/close`, `auth_methods()`, `authenticate()`, `logout()`, model-selector capability, session-additional-directories, client-generated user-message-ids.
- **Image input:** Zed only attaches images if the agent advertises `promptCapabilities.image` (images via @-mention or drag-into-panel — https://zed.dev/docs/ai/agent-panel#images-as-context).
- **Plan:** the agent streams `SessionUpdate::Plan` and Zed renders/updates it (`update_plan` in `crates/acp_thread/src/acp_thread.rs`).
- **Tool permissions:** Zed's own "tool permissions" settings page; for external agents "Zed ACP/tool forwarding permissions may apply; native tool permissions depend on the agent" — https://zed.dev/docs/ai/external-agents#configuration-boundaries
- Zed-configured **MCP servers may be forwarded to External Agents over ACP** (and agents may also read their own native MCP config) — https://zed.dev/docs/ai/external-agents#mcp

## 6. How Zed renders agent updates

ACP v1 `SessionUpdate` variants Zed consumes (schema `agent-client-protocol-schema/src/v1/client.rs`): `UserMessageChunk`, `AgentMessageChunk`, `AgentThoughtChunk`, `ToolCall`, `ToolCallUpdate`, `Plan`, `AvailableCommandsUpdate`, `CurrentModeUpdate`, `ConfigOptionUpdate`, `SessionInfoUpdate`, `UsageUpdate`.

Rendering behavior (https://zed.dev/docs/ai/agent-panel):
- **Assistant messages / reasoning / tool calls**: responses stream in with indicators showing which tools are in use; tool-call cards with statuses (granted/denied etc. via `ToolCallStatus`).
- **Permission/consent**: agent tool-call permission requests surface as interactive grant/deny prompts; outcome handling (`RequestPermissionOutcome::{Selected, Cancelled, InterruptedByFollowUp}`) with per-call oneshot response channels in `crates/acp_thread/src/acp_thread.rs`.
- **File edits/diffs**: agents request writes via `fs/writeTextFile` (client handler `handle_write_text_file` → `thread.write_text_file`, `crates/agent_servers/src/acp.rs`); Zed applies them to buffers, snapshots a **git checkpoint per message**, and surfaces:
  - a "Review Changes" accordion above the message editor + multi-buffer review pane (`shift-ctrl-r`) with **accept/reject per hunk** and full syntax highlighting + LSP;
  - optional inline single-file diff review via `agent.single_file_review: true`;
  - a **"Restore Checkpoint"** button per message (even mid-edit) to roll the codebase back;
  - the "follow the agent" crosshair jumps the editor to each file the agent touches.
- Checkpoints use Zed's git store (`git_store.checkpoint`, `crates/acp_thread/src/acp_thread.rs`).
- Debugging: `dev: open acp logs` dumps the raw JSON-RPC messages between Zed and the agent — https://zed.dev/docs/ai/external-agents#debugging

## 7. Known working examples / packages to model after

- **claude-code-acp** → npm `claude-code-acp` (installs `cc-acp`), repo https://github.com/carlrannaberg/cc-acp ("Claude Code ACP Agent for Zed Editor"): **"Full ACP v1 protocol implementation"**, JSON-RPC over stdio, streams responses, tool-call handling, interactive permission requests, session management; config example in §2; env knobs `CLAUDE_API_KEY`, `CLAUDE_MODEL`, `CLAUDE_ALLOWED_TOOLS`, `CLAUDE_PERMISSION_MODE`, etc. (Note: the older `anas-araid/claude-code-acp` repo now 404s/renamed.)
- **@aicoach/acp** — npm `@aicoach/acp` (0.1.0-alpha.4), "AI Coach as a Zed-native agent over ACP. Skills, marketplace, model bake-offs, and nano apps inside any ACP-compatible editor" — https://www.npmjs.com/package/@aicoach/acp (repo `git+https://github.com/johnefemer/aicoach`, `packages/aicoach-acp`; currently unlisted/404 via API; npm readme empty; homepage https://aicoach.pw/acp).
- **Qwen Code** — official Zed integration: install CLI (`npm i -g @qwen-code/qwen-code`), then registry install, or manual `"type":"custom","command":"qwen","args":["--acp"]` — https://qwenlm.github.io/qwen-code-docs/en/users/integration-zed/
- **Zed's own ACP code** (best reference implementation of the *client*): `crates/acp_thread/` (thread + connection + diff), `crates/acp_tools/`, `crates/agent_servers/` (server config + spawning + RPC handlers) in https://github.com/zed-industries/zed.
- **codex-acp** — `@agentclientprotocol/codex-acp` (formerly zed-industries/codex-acp, development moved to the ACP org): "a stdio ACP agent server. It starts the Codex App Server, translates ACP requests into Codex operations" — auth via ChatGPT login / `CODEX_API_KEY` / `OPENAI_API_KEY` / gateway; env knobs `CODEX_PATH`, `NO_BROWSER`, `INITIAL_AGENT_MODE` — https://github.com/agentclientprotocol/codex-acp
- Agent directory (clients & agents on ACP): https://zed.dev/acp and https://zed.dev/acp/editor/zed

## 8. Auth / key provisioning flow when Zed launches a custom agent

- **Default posture: the agent owns its auth/billing.** "Anthropic API key configured for Zed Agent does not automatically configure Claude Agent"; "Zed LLM provider API keys saved in the local keychain are not automatically the same as an External Agent's credentials." — https://zed.dev/docs/ai/external-agents#agent-auth-config and #remote-projects
- For a **custom** agent, Zed injects **no API keys** — supply them via `agent_servers.<id>.env` (e.g. cc-acp's `CLAUDE_API_KEY`) or the agent's own config files. The only always-added env are proxy vars and (optionally) `NO_BROWSER=1`.
- **ACP-native auth flow**: the agent advertises auth methods in its `InitializeResponse`; Zed advertises `auth.terminal: true` (meta `terminal-auth`) and can launch a terminal-based sign-in task (`terminal_auth_task`, `crates/agent_servers/src/acp.rs`); `authenticate()` / `logout()` are part of `AgentConnection`. Example: Gemini CLI's `/auth` (Zed even overrides Gemini's auth methods to a terminal auth method) — source comment "TODO: Remove this override once Google team releases their official auth methods".
- **Registry special-cases** (Zed injects, source `crates/agent_servers/src/custom.rs`):
  - `gemini`: sets `SURFACE=zed`, then `GEMINI_API_KEY` from env `GEMINI_API_KEY`/`GOOGLE_AI_API_KEY`, else from the macOS keychain entry for Google AI — mirrors docs: "if you have configured an API key for Zed's Google AI provider, Zed passes that key to Gemini CLI as GEMINI_API_KEY."
  - `claude-acp`: injects an **empty** `ANTHROPIC_API_KEY=""` marker.
  - `codex-acp`: passes through Zed's own process env `CODEX_API_KEY`/`OPEN_AI_API_KEY` if present.
- User-visible flows: Claude Agent `/login` in-thread (API key or Claude Code where supported); Codex's native login/logout; Gemini CLI's Google/Vertex login; all billed directly between user and provider. — https://zed.dev/docs/ai/external-agents

---

### Source index (primary)
- https://zed.dev/docs/ai/external-agents · https://zed.dev/docs/ai/agent-panel · https://zed.dev/docs/ai/agent-settings · https://zed.dev/acp/editor/zed · https://zed.dev/blog/bring-your-own-agent-to-zed · https://zed.dev/blog/acp-registry
- https://github.com/zed-industries/zed — `Cargo.toml` (line 521), `crates/agent_servers/src/{acp,custom,agent_servers}.rs`, `crates/acp_thread/src/{acp_thread,connection,diff}.rs`, `crates/acp_tools/`, `crates/settings_content/src/{agent,settings_content}.rs`, `crates/project/src/{agent_server_store,environment}.rs`
- https://agentclientprotocol.com (spec, updates, announcements/acp-v2-draft) · https://github.com/agentclientprotocol/agent-client-protocol (schema v1/v2) · https://github.com/agentclientprotocol/rust-sdk · https://crates.io/crates/agent-client-protocol (2.0.0 changelog)
- https://qwenlm.github.io/qwen-code-docs/en/users/integration-zed/
- https://github.com/carlrannaberg/cc-acp (claude-code-acp) · https://github.com/agentclientprotocol/codex-acp · https://www.npmjs.com/package/@aicoach/acp

*Research date: fetched from live primary sources; ACP v2 draft announcement dated 2026-07-20; agent-client-protocol crate 2.0.0 released 2026-07-23.*
