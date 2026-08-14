# Agent Client Protocol (ACP) — Fact Sheet

> Research-only fact sheet compiled from primary sources: the official docs site and the canonical JSON schemas in the protocol repo. All facts below are cited inline.
>
> **Repo identity (important for citations):** the repository moved `coder/agent-client-protocol` → `zed-industries/agent-client-protocol` → now **`agentclientprotocol/agent-client-protocol`** (the v2 announcement links there: https://github.com/agentclientprotocol/agent-client-protocol). The docs site (Mintlify) renders the same content at https://agentclientprotocol.com. All raw sources below were verified against `raw.githubusercontent.com/zed-industries/agent-client-protocol/main` (GitHub redirects renamed repos, so these URLs still resolve); the current canonical org name is `agentclientprotocol`.
>
> **Version status:** ACP **v1 is stable** (tags v1.0.0 … v1.6.0 on the repo). **v2 is a Draft** — announced 2026-07-20, "various pieces can, and will, change before stabilization" (https://agentclientprotocol.com/announcements/acp-v2-draft). Canonical artifacts: `schema/v1/schema.json` (stable v1), `schema/v2/schema.json` (stable v2 baseline), plus `schema/v2/schema.unstable.json` (opt-in draft features). Docs are versioned: `docs/protocol/v1/*` and `docs/protocol/v2/*` in the repo, mirrored at `agentclientprotocol.com/protocol/v1/*` and `/protocol/v2/*`.

---

## 1. Transport options — and which is canonical for a local editor↔agent link

**stdio is the canonical, baseline transport; it is the only standard transport for a local editor↔agent link.** The v1 stable transports doc defines exactly two things and says: *"Agents and clients **SHOULD** support stdio whenever possible"* (https://agentclientprotocol.com/protocol/v1/transports).

- **stdio** (v1 stable, unchanged in v2): the client launches the agent as a subprocess; the agent reads JSON-RPC from `stdin` and writes to `stdout`; messages are **newline-delimited** (`\n`), MUST NOT contain embedded newlines, MUST be UTF-8; the agent MAY log to `stderr`; anything else on `stdout` is forbidden (https://agentclientprotocol.com/protocol/v1/transports#stdio, https://agentclientprotocol.com/protocol/v2/transports#stdio).
- **Streamable HTTP** — listed in the stable v1/v2 docs only as *"_Streamable HTTP_ — *In discussion, draft proposal in progress*"* (https://agentclientprotocol.com/protocol/v1/transports#_streamable-http_). The full proposal is the **Streamable HTTP & WebSocket Transport RFD** (https://agentclientprotocol.com/rfds/streamable-http-websocket-transport): a single `/acp` endpoint with two profiles — (a) **Streamable HTTP**: POST for client→server messages (returns `202 Accepted` immediately, except `initialize` which returns `200 OK` with JSON + the `Acp-Connection-Id` header), long-lived **GET SSE streams** (one connection-scoped stream + one session-scoped stream per session), `DELETE` to terminate, **HTTP/2 REQUIRED**; (b) **WebSocket upgrade** on the same endpoint (`GET` with `Upgrade: websocket`, HTTP 101, `Acp-Connection-Id` returned in upgrade headers). Clients supporting remote ACP MUST support both profiles; servers MAY support only WebSocket. Identity headers: `Acp-Connection-Id` (connection) and `Acp-Session-Id` (session). Batch JSON-RPC returns 501 on HTTP. This RFD is targeted for **v1 as an additive feature**; reliability primitives (message IDs on streams, SSE resumability, defined reconnect, keepalive) are deferred to **v2**.
- **Custom transports**: agents/clients MAY implement custom transports, but MUST preserve the JSON-RPC message format and lifecycle requirements (https://agentclientprotocol.com/protocol/v1/transports#custom-transports).
- JSON-RPC 2.0 **batch** handling is specified (v2 transports doc): batches allowed, no reply to notifications, per-entry `-32600` for invalid entries, empty batch → single `-32600`, invalid batch JSON → `-32700`. Lifecycle-sensitive messages (`initialize`, `auth/login`, `session/new`, `session/resume`, `session/prompt`) SHOULD NOT be batched (https://agentclientprotocol.com/protocol/v2/transports#json-rpc-batch-messages).

**Bottom line for a local editor↔agent link:** stdio, newline-delimited JSON-RPC 2.0. Nothing else is stable today.

---

## 2. Full JSON-RPC method list (both directions)

Canonical source: `schema/v1/meta.json` and `schema/v2/meta.json` (method-name constants) and `schema/v1/schema.json` / `schema/v2/schema.json` (full request/response shapes): https://raw.githubusercontent.com/zed-industries/agent-client-protocol/main/schema/v1/schema.json and .../schema/v2/schema.json.

### v1 (stable) — full roster

**Client → Agent (agentMethods, JSON-RPC requests):**
| Method | Required params | Result |
|---|---|---|
| `initialize` | `protocolVersion` | `protocolVersion`, `agentCapabilities`, `authMethods` (array), optional `agentInfo` |
| `authenticate` | `methodId` | `{}` |
| `logout` | — | `{}` |
| `session/new` | `cwd`, `mcpServers` | `sessionId` (+ optional `modes`, `configOptions`) |
| `session/load` | `sessionId`, `cwd`, `mcpServers` | (replays history via `session/update`, then `null`) |
| `session/list` | optional `cwd`, `cursor` | `sessions` + optional `nextCursor` |
| `session/delete` | `sessionId` | `{}` |
| `session/resume` | `sessionId`, `cwd` (+ `additionalDirectories`, `mcpServers`) | `{}` |
| `session/close` | `sessionId` | `{}` |
| `session/set_mode` | `sessionId`, `modeId` | `{}` |
| `session/set_config_option` | `sessionId`, `configId`, `value` | updated `configOptions` |
| `session/prompt` | `sessionId`, `prompt` (ContentBlock[]) | `{ "stopReason": ... }` |
| `_`-prefixed custom methods (ext) | free-form | free-form |

**Agent → Client (clientMethods, JSON-RPC requests):**
| Method | Required params | Result |
|---|---|---|
| `fs/read_text_file` | `sessionId`, `path` (+ `line`, `limit`) | `{ "content": string }` |
| `fs/write_text_file` | `sessionId`, `path`, `content` | `null` |
| `session/request_permission` | `sessionId`, `toolCall`, `options` | `{ "outcome": "selected"\|"cancelled" }` |
| `terminal/create` | `sessionId`, `command` (+ `args`, `env`, `cwd`, `outputByteLimit`) | `{ "terminalId" }` |
| `terminal/output` | `sessionId`, `terminalId` | `{ output, truncated, exitStatus? }` |
| `terminal/release` | `sessionId`, `terminalId` | `{}` |
| `terminal/wait_for_exit` | `sessionId`, `terminalId` | `{ exitCode?, signal? }` |
| `terminal/kill` | `sessionId`, `terminalId` | `{}` |
| `elicitation/create` | `message` | `{ elicitationId }` |

**Notifications:** Client→Agent: `session/cancel` (params `sessionId`). Agent→Client: `session/update` (params `sessionId`, `update`), `elicitation/complete` (params `elicitationId`). Both directions: `_`-prefixed custom notifications. **Protocol-level:** `$/cancel_request` (params `requestId`? — cancels a request, response is error `-32800` or a valid response). Error codes: `-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal, `-32800` Request cancelled, `-32000` Authentication required, `-32002` Resource not found (schema ErrorCode defs).

### v2 (draft) — full roster (differences from v1)

**Client → Agent:** `initialize` (renamed fields, see §3), `auth/login` (params `methodId`; replaces `authenticate`), `auth/logout` (replaces `logout`), `session/new` (`mcpServers` now optional; response has `configOptions`, no `modes`), `session/list` (required, no capability), `session/delete` (optional via `session.delete`), `session/resume` (+ optional `replayFrom`; required method), `session/close` (required), `session/set_config_option` (unchanged), `session/prompt` (**response is `{}` acknowledgment — see §4/§5**), `_`-custom methods.
**Removed in v2:** `session/load` (→ `session/resume` + `replayFrom: {"type":"start"}`), `session/set_mode` (→ config options), `authenticate`/`logout` (→ `auth/login`/`auth/logout`), and **all `fs/*` and `terminal/*` client methods** (see §6).

**Agent → Client:** `session/request_permission` (params restructured: `sessionId`, `title` (required), `description?`, `subject?`, `options` — see §7), `elicitation/create`. `fs/*` and `terminal/*` **no longer exist**.

**Notifications:** same set as v1 (`session/update`, `elicitation/complete`, `session/cancel`, `$/cancel_request`, `_`-custom), but the `session/update` payload types are renamed in the schema to `UpdateSessionNotification` / `CancelSessionNotification` (no wire change).

(Full method tables extracted from the schemas; also see the v2 migration guide's "Method changes" table: https://agentclientprotocol.com/protocol/v2/migration.)

---

## 3. `initialize` handshake and capability negotiation

Docs: https://agentclientprotocol.com/protocol/v1/initialization and https://agentclientprotocol.com/protocol/v2/initialization.

**Version:** `protocolVersion` is a single integer identifying the **MAJOR** protocol version (v1 → `1`, v2 → `2`). Client sends the latest it supports; agent echoes it if supported, else responds with its own latest; client SHOULD disconnect if it can't accept the agent's answer. (Note: the pre-stabilization draft used a date string like `2025-03-26`; the **stable** protocol uses integers.)

### v1 fields
- `initialize` request params: `protocolVersion` (required), `clientCapabilities` (optional), `clientInfo` (optional; `{name, title?, version}`).
- **`clientCapabilities`** (v1): `fs: { readTextFile: boolean, writeTextFile: boolean }` (default both `false`), `terminal: boolean` (default `false`), `session: { configOptions: { boolean: {} } }` (optional), `elicitation: { form?, url? }` (optional).
- **`agentCapabilities`** (v1, in the response): `loadSession: boolean` (default false) — gates `session/load`; `promptCapabilities: { image, audio, embeddedContext }` (all default false; **text and resource-link are baseline, not flags**); `mcpCapabilities: { http, sse }`; `sessionCapabilities: { list, delete, additionalDirectories, resume, close }` (each `{}` = supported); `auth: { logout: {} }`.
- Response also carries `authMethods: AuthMethod[]` (see §8) and optional `agentInfo`.
- Rule: capabilities omitted in `initialize` are treated as **UNSUPPORTED** (no implicit defaults except the schema defaults above); new capabilities are never a breaking change.

### v2 fields (per the migration guide's "Initialization" section)
- Request params: `protocolVersion` (= 2), **`info` (required, was optional `clientInfo`)**, `capabilities` (was `clientCapabilities`). Response: `protocolVersion`, **`info` (required)**, `capabilities` (was `agentCapabilities`), `authMethods` (optional).
- **Support markers are objects, not booleans**: `{}` (or fields) = supported; omitted/`null` = unsupported. E.g. `capabilities.session.prompt.image != null` instead of `=== true`.
- **Capabilities reorganized**: all session-scoped groups nest under `capabilities.session`: `session.prompt.{image,audio,embeddedContext}`, `session.mcp.{stdio,http}`, `session.delete`, `session.additionalDirectories`. Advertising `capabilities.session` (even `{}`) commits the agent to the **baseline session methods**: `session/new`, `session/list`, `session/resume`, `session/close`, `session/prompt`, `session/cancel`, `session/update`. The old `loadSession`, `list`/`resume`/`close` markers are gone. **v2 defines no standard Client capability fields** — `fs` and `terminal` were removed (§6); only `elicitation` remains on the client side.
- `capabilities.auth` is orthogonal to `authMethods` (it advertises auth-related extensions only).

### Corrections to common assumptions in the question
- There is **no `plan` capability flag** in stable v1 or v2 — plans are a `session/update` kind (`plan` / `plan_update`), baseline.
- **`availableModes` is not an agent capability** in stable v1: it lives in `SessionModeState.availableModes` returned in `session/new`/`session/load` responses (https://agentclientprotocol.com/protocol/v1/session-modes). (The pre-stabilization draft had an `availableModes` agent capability; it was removed.)
- **`session/stop` does not exist** in any ACP version. The lifecycle-close surface is `session/close` (cancel ongoing work + free resources) and `session/cancel` (cancel a prompt turn).

---

## 4. Session lifecycle: `session/new`, `session/load`, `session/prompt`, `session/stop`, `session/set_mode`, `session/cancel`

Docs: https://agentclientprotocol.com/protocol/v1/session-setup, https://agentclientprotocol.com/protocol/v1/prompt-turn, https://agentclientprotocol.com/protocol/v2/session-setup, https://agentclientprotocol.com/protocol/v2/prompt-lifecycle.

- **`session/new`** (v1, v2): params `cwd` (absolute, required; establishes the session's filesystem root and relative-path base), `mcpServers` (v1: required; v2: optional), optional `additionalDirectories` (v1: `sessionCapabilities.additionalDirectories`; v2: `session.additionalDirectories`). Returns `sessionId`. v1 may also return `modes` (`{currentModeId, availableModes[]}`) and `configOptions`; v2 returns `configOptions` only.
- **`session/load`** (v1 only, gated by `agentCapabilities.loadSession`): params `sessionId`, `cwd`, `mcpServers`. The agent MUST replay the entire conversation as `session/update` notifications (message chunks with `messageId`s), then respond (`null`). **Removed in v2** — use `session/resume` with `replayFrom: { "type": "start" }`.
- **`session/resume`** (v1 gated by `sessionCapabilities.resume`; v2 required): params `sessionId`, `cwd`, optional `mcpServers`, `additionalDirectories`; v2 adds optional `replayFrom` (tagged union; `{ "type": "start" }` replays the whole conversation). No replay by default; returns `{}` when ready.
- **`session/prompt`**:
  - **v1**: params `sessionId`, `prompt` (`ContentBlock[]`; client MUST restrict content to negotiated `promptCapabilities`). The request stays pending for the whole turn; agent streams `session/update` notifications; the **response** carries the terminal `stopReason`: `end_turn | max_tokens | max_turn_requests | refusal | cancelled` (https://agentclientprotocol.com/protocol/v1/prompt-turn#stop-reasons).
  - **v2**: the response is an **empty `{}` acknowledgment** the moment the prompt is accepted. The agent MUST then send a `user_message`/`user_message_chunk` update with the agent-owned `messageId` (source of truth for where the message was inserted), a `state_update` `running`, and eventually an idle `state_update` with the `stopReason` (https://agentclientprotocol.com/protocol/v2/prompt-lifecycle).
- **`session/cancel`** (notification, both versions): params `sessionId`. Client SHOULD pre-mark pending tool calls `cancelled`; client MUST answer pending `session/request_permission` with `outcome: "cancelled"`. Agent SHOULD abort LLM + tool calls, flush pending `session/update`s, then **v1**: respond to `session/prompt` with `stopReason: "cancelled"` (MUST even if underlying APIs throw); **v2**: send idle `state_update` with `stopReason: "cancelled"`.
- **`session/close`** (v1 gated by `sessionCapabilities.close`; v2 required): params `sessionId`; behaves like `session/cancel` plus frees session resources; returns `{}`. Error if the session doesn't exist / isn't active.
- **`session/set_mode`** (v1 only): params `sessionId`, `modeId` (must be in `availableModes`). Agent can switch modes itself via the `current_mode_update` session update. **Removed in v2** — mode/model/thought-level state is expressed via **session config options** (`session/set_config_option` params `sessionId`, `configId`, `value`; response returns full updated `configOptions`; agent changes arrive as `config_option_update`). v2 stable config `category` values: `mode`, `model`, `model_config`, `thought_level` (https://agentclientprotocol.com/protocol/v2/migration).
- **`session/list`** (v1 gated by `sessionCapabilities.list`; v2 required): params optional `cwd`, `cursor`; returns `sessions: SessionInfo[]` + optional `nextCursor`; agents push metadata changes via `session_info_update`. **`session/delete`** (both versions, v1 gated by `sessionCapabilities.delete`, v2 by `session.delete`): params `sessionId`.
- **Working-directory rule**: all file paths MUST be absolute; line numbers are 1-based; `cwd` must be used by the session regardless of where the agent subprocess was spawned (https://agentclientprotocol.com/protocol/v1/session-setup#working-directory).

---

## 5. The agent→client update mechanism (`session/update`) and every update kind

`session/update` is a JSON-RPC **notification** (no response) with params `sessionId` + `update`, where `update` is a tagged union discriminated by `sessionUpdate`.

**v1 (stable) — 11 kinds** (https://agentclientprotocol.com/protocol/v1/prompt-turn#3-agent-reports-output; schema `SessionUpdate`):
1. `user_message_chunk` — chunk of the user's message (ContentChunk; optional `messageId`)
2. `agent_message_chunk` — chunk of the agent's response
3. `agent_thought_chunk` — chunk of internal reasoning
4. `tool_call` — new tool call created (`toolCallId`, `title`, `kind`, `status`, `content`, `locations`, `rawInput`, `rawOutput`)
5. `tool_call_update` — patch of a tool call (`toolCallId` required; all else optional); statuses `pending | in_progress | completed | failed`
6. `plan` — full plan replacement (`entries: [{content, priority: high|medium|low, status: pending|in_progress|completed}]`; client MUST replace the whole plan)
7. `available_commands_update` — slash commands list (`availableCommands: [{name, description, input?}]`)
8. `current_mode_update` — agent changed mode (`modeId`)
9. `config_option_update` — config option(s) changed
10. `session_info_update` — session metadata changes (title etc.)
11. `usage_update` — token/cost state (`used`, `size` required; optional `cost: {amount, currency ISO-4217}`)

**v2 (draft) — 16 kinds** (schema `SessionUpdate`; https://agentclientprotocol.com/protocol/v2/prompt-lifecycle):
1–3. `user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` — kept; **`messageId` now REQUIRED**
4–6. **NEW** `user_message` / `agent_message` / `agent_thought` — whole-message **upserts** (full `content` array) keyed by `messageId`; patch semantics: omitted = unchanged, `null`/`[]` = clear, concrete array = replace; chunks append
7. **NEW** `state_update` — foreground work state: `running | idle | requires_action`; idle carries `stopReason`; `requires_action` while blocked on permission
8. `tool_call` — **REMOVED** (first `tool_call_update` with an unseen `toolCallId` creates the tool call)
9. `tool_call_update` — kept as explicit upsert; `status` adds `cancelled`; omit/`null`/value patch semantics; `content`/`locations` replaced wholesale when present
10. **NEW** `tool_call_content_chunk` — appends a single `ToolCallContent` item to a tool call
11. **NEW** `terminal_update` — Agent-owned display-only terminal upsert keyed by `terminalId` (patch fields: `command`, `cwd`, `output` (base64 snapshot, replaces all bytes), `exitStatus`, `_meta`)
12. **NEW** `terminal_output_chunk` — appends independently base64-encoded output bytes (`terminalId`, `data`); decode-then-append, do not concat encoded strings
13. `plan` → **`plan_update`** — payload `{ type: "items", planId, entries[] }`; each update replaces that plan's entries; `planId` allows multiple plans; entry `status` adds `cancelled`
14. `available_commands_update` — kept; command `input` is now a tagged union with `type: "text"` + `hint`
15. `config_option_update` — unchanged (replaces `current_mode_update`)
16. `session_info_update`, `usage_update` — unchanged

Tool-call fields: `toolCallId`, `title`, `kind` (`read | edit | delete | move | search | execute | think | fetch | other`), `status`, `content` (`type: content|diff|terminal`), `locations` (follow-along: `{path, line?}`), `rawInput`, `rawOutput` (https://agentclientprotocol.com/protocol/v1/tool-calls).

Content blocks are MCP's `ContentBlock` shape: `text`, `image`, `audio`, `resource` (embedded), `resource_link` (https://agentclientprotocol.com/protocol/v1/content). v2 realigns fields with the latest MCP spec (e.g. `resource_link.icons`) and marks base64/URI/annotations-priority constraints in the schema.

---

## 6. `fs/read_text_file`, `fs/write_text_file`, `terminal/*` — WHO owns the filesystem and terminal

**In v1: the CLIENT (the editor) owns the filesystem and the terminals — the agent only *requests*.** These are agent→client JSON-RPC **requests** that the client executes against its own environment and answers (https://agentclientprotocol.com/protocol/v1/file-system, https://agentclientprotocol.com/protocol/v1/terminals):

- **`fs/read_text_file`** (agent→client; gated by client capability `fs.readTextFile`): params `sessionId`, `path` (absolute), optional `line` (1-based) and `limit`. The client reads from **its** filesystem — including **unsaved editor buffer state** — and returns `{ content }`.
- **`fs/write_text_file`** (gated by `fs.writeTextFile`): params `sessionId`, `path` (absolute), `content`; the client creates the file if missing and tracks the modification; returns `null`.
- **`terminal/create`** (gated by client capability `terminal`): params `sessionId`, `command`, optional `args`, `env`, `cwd` (absolute), `outputByteLimit`. The **client runs the command** in its environment and returns a `terminalId` immediately. Lifecycle: `terminal/output` (returns `{output, truncated, exitStatus?}`), `terminal/wait_for_exit` (`{exitCode?, signal?}`), `terminal/kill` (kill without releasing), `terminal/release` (kill if running + free; ID invalid afterwards). The agent MUST release terminals it no longer needs. Terminal output can be embedded in tool-call content (`{"type":"terminal","terminalId":...}`) for live display; output keeps displaying after release. Agents can build timeouts by combining create → wait_for_exit race → kill → output → release.
- Capability gate: agents MUST check `clientCapabilities.fs.{readTextFile,writeTextFile}` / `clientCapabilities.terminal` before calling (https://agentclientprotocol.com/protocol/v1/initialization#client-capabilities).
- Note: the **working directory** semantics also underscore client ownership of the environment — `cwd` is chosen by the client, is absolute, and is used by the session "regardless of where the Agent subprocess was spawned".

**In v2: this whole surface is REMOVED** (RFD "v2 Client Filesystem and Terminal Execution Surface": https://agentclientprotocol.com/rfds/v2/client-filesystem-terminal-capabilities; migration guide: https://agentclientprotocol.com/protocol/v2/migration):
- Removed: `clientCapabilities.fs`, `clientCapabilities.terminal`, `fs/read_text_file`, `fs/write_text_file`, `terminal/create|output|release|wait_for_exit|kill`, and the client-owned `terminal` tool-call content semantics. Rationale per the RFD: not widely adopted; agents are moving to their own sandboxing/execution.
- **v2 replacement for clients that want to expose editor state/tools to the agent: pass an MCP server** via `mcpServers` on `session/new`/`session/resume` ("puts those tools on the same footing as every other tool the Agent uses").
- v2 keeps a `terminal` tool-call content **reference** (`{"type":"terminal","terminalId":...}`) but it is **Agent-owned, display-only**: no input, resize, interrupt, kill, wait, release, or execution semantics; all state arrives via `terminal_update` / `terminal_output_chunk` session updates (§5). A `command` permission subject (§7) "approves the Agent to execute the command; it never asks the Client to execute it."

---

## 7. Permission/consent flow: `session/request_permission`

Docs: https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission, https://agentclientprotocol.com/protocol/v2/tool-calls#requesting-permission, and RFD https://agentclientprotocol.com/rfds/v2/permission-requests.

- Agent → Client **request**: v1 params `sessionId`, `toolCall` (a `ToolCallUpdate` describing the operation), `options` (required). **v2 params**: `sessionId`, **`title` (required)** (prompt copy; decoupled from the tool call's title), `description` (optional), `subject` (optional tagged union), `options` (required).
- **`subject`** (v2): `{ "type": "tool_call", "toolCall": ToolCallUpdate }` or `{ "type": "command", "command", "cwd" (required, absolute), "toolCallId"?, "terminalId"? }`; may be omitted entirely for approvals without structured context.
- **`options`**: array of `PermissionOption { optionId, name, kind }` where `kind` ∈ `allow_once | allow_always | reject_once | reject_always` (UI hints; extendable in v2 with `_`-prefixed values).
- **Response outcome** (both versions): `{ "outcome": "selected", "optionId": ... }` or `{ "outcome": "cancelled" }` (cancelled is REQUIRED when the prompt turn is cancelled). Clients MAY auto-allow/reject per user settings. In v2, an agent receiving an unknown outcome MUST NOT treat it as approval.
- **v2 state integration**: while a permission request is pending, the agent SHOULD send `state_update: requires_action`, and `running` again once resolved.
- v1 schema default: `RequestPermissionRequest` requires `sessionId`, `toolCall`, `options` (from `schema/v1/schema.json`).

---

## 8. Auth: `authenticate` / `authMethods` (v1) and `auth/login` / `auth/logout` (v2)

Docs: https://agentclientprotocol.com/protocol/v1/authentication, https://agentclientprotocol.com/protocol/v2/authentication.

- **v1**: agents advertise `authMethods: AuthMethod[]` in the `initialize` response. `AuthMethod` (default type `"agent"`): `{ id, name, description? }` — the client calls **`authenticate`** with `methodId` (must match an advertised method id). Success → `{}`; afterwards `auth_required` errors stop for new sessions. Logout is **optional** via the capability `agentCapabilities.auth.logout: {}`; client calls **`logout`** (`params: {}`). After logout, session behavior is unspecified (agents may keep/kill sessions or return auth errors). Error code for auth-gated requests: `-32000` (Authentication required).
- **v2**: `authMethods` entries use `{ methodId, type (required), name, description? }`; stable `type` is `"agent"` (custom types MUST start with `_`). **Non-empty `authMethods` ⇒ the agent MUST implement both `auth/login` and `auth/logout`; omitted/empty ⇒ clients MUST NOT call either.** No logout capability marker. `auth/login` params `methodId`; success → `{}`. `capabilities.auth` is orthogonal (extensions only). The transport RFD notes auth is layered on top of HTTP/WS via headers/query/subprotocols.

---

## 9. ACP v1 (stable) vs v2 (draft) — key differences

Primary source: https://agentclientprotocol.com/protocol/v2/migration ("If you only remember five things…") and the v2 announcement https://agentclientprotocol.com/announcements/acp-v2-draft.

1. **Prompt lifecycle rewritten.** v1: `session/prompt` response (`stopReason`) ends the turn; the request stays pending while streaming. v2: the response is a `{}` acknowledgment; progress/completion move entirely into `session/update` notifications — `user_message` acknowledgment, `state_update: running/requires_action/idle` (idle carries `stopReason`), including `cancelled` after `session/cancel`. Enables background work, queuing, replay, and multi-client sessions.
2. **Updates are upserts.** Uniform patch semantics across messages, tool calls, terminals, plans: omitted = unchanged, `null` = cleared, value = replaced, chunks append. `messageId` is **required** on all message chunks/updates in v2 (v1: optional).
3. **Client fs/terminal/session-modes surfaces removed.** `fs/*`, `terminal/*`, `session/set_mode`, `modes`, `current_mode_update` all gone; client-owned terminal replaced by agent-owned display-only `terminal_update`/`terminal_output_chunk`; client-side tools exposed via MCP servers instead.
4. **Capabilities reorganized.** One `capabilities` + required `info` on both sides; object support markers instead of booleans; session-scoped groups under `capabilities.session`; baseline session methods (`session/new`, `list`, `resume`, `close`, `prompt`, `cancel`, `update`) required when `session` is advertised; `session/load` removed (resume + `replayFrom`).
5. **Forward compatibility by default.** All enum-like fields and tagged unions accept unknown values; `_`-prefixed = implementation-specific, unknown non-underscore = reserved for future ACP versions.
6. Other v2 changes: `session/request_permission` restructured (§7); diffs replaced (`oldText`/`newText` → structured `changes` with `operation: add|delete|modify|move|copy`, `fileType`, `mimeType` + optional `git_patch` text); plans → `plan_update` with `planId` + `type: "items"`; slash-command `input` becomes tagged union; MCP configs get `type` discriminators, SSE transport dropped, `stdio` becomes explicit capability; ID naming rule (`methodId`, `configId`, `groupId`); JSON-RPC batch behavior defined on stdio.
7. **Status**: v1 stable (tags up to v1.6.0); v2 is a draft published 2026-07-20, gated behind `protocolVersion: 2` + feature flags; implementers are told to support both versions side by side. Unstable v2 additions live in `schema/v2/schema.unstable.json` (not implied by `protocolVersion: 2`).

---

## 10. Extension / custom-capability mechanism (`_meta`, underscore methods, open variants)

Docs: https://agentclientprotocol.com/protocol/v1/extensibility and https://agentclientprotocol.com/protocol/v2/extensibility.

1. **`_meta` field on every protocol type** (requests, responses, notifications, and nested types: content blocks, tool calls, plan entries, capability objects): `{ [key: string]: unknown }` for attaching custom data. Root-level `_meta` keys `traceparent`, `tracestate`, `baggage` SHOULD be reserved for W3C trace context (interop with MCP/OpenTelemetry). Implementations MUST NOT add custom fields at the root of a spec type — all root names are reserved. In v2's upsert updates, top-level `_meta` follows patch semantics (omitted = unchanged, `null` = clears).
2. **Custom methods/notifications**: any JSON-RPC method name starting with `_` is reserved for extensions (e.g. `_zed.dev/workspace/buffers`); requests expect a response, notifications are one-way; unrecognized custom **requests** → standard `-32601 Method not found`, unrecognized custom **notifications** SHOULD be ignored. Same rule in v1 and v2.
3. **Advertising custom capabilities**: use `_meta` inside capability objects during `initialize`, e.g. `agentCapabilities._meta = { "zed.dev": { "workspace": true } }` (v1) / `capabilities._meta` (v2), so peers can check availability before calling extensions.
4. **Open enums/tagged unions (v2, new)**: enum-like values accept unknown variants — `_`-prefixed values are implementation extensions; unknown non-underscore values are reserved for future ACP versions; receivers SHOULD preserve unknown values when storing/replaying/proxying and fall back to generic rendering; closed discriminators may still reject unknown values when they can't continue safely. Examples: stop reasons, session states, permission option kinds/outcomes, auth method types, MCP transport types, command input types, plan types.
5. **RFD process** as the governance mechanism for adding features to both v1 and v2 (https://agentclientprotocol.com/rfds/about).

---

## Sources (primary)

- Docs site (Mintlify, renders repo docs): https://agentclientprotocol.com — esp. `/get-started/introduction`, `/get-started/architecture`, `/protocol/v1/overview`, `/protocol/v1/initialization`, `/protocol/v1/session-setup`, `/protocol/v1/prompt-turn`, `/protocol/v1/file-system`, `/protocol/v1/terminals`, `/protocol/v1/tool-calls`, `/protocol/v1/authentication`, `/protocol/v1/extensibility`, `/protocol/v1/transports`, `/protocol/v1/session-modes`, `/protocol/v1/cancellation`, `/protocol/v1/content`, `/protocol/v1/session-config-options`, `/protocol/v2/overview`, `/protocol/v2/initialization`, `/protocol/v2/session-setup`, `/protocol/v2/prompt-lifecycle`, `/protocol/v2/migration`, `/protocol/v2/authentication`, `/protocol/v2/extensibility`, `/protocol/v2/transports`, `/announcements/acp-v2-draft`, `/rfds/streamable-http-websocket-transport`, `/rfds/v2/client-filesystem-terminal-capabilities`, `/rfds/v2/permission-requests`.
- Repo (current org): https://github.com/agentclientprotocol/agent-client-protocol (previously `zed-industries/agent-client-protocol`, originally `coder/agent-client-protocol`; GitHub redirects old names). Canonical artifacts: `schema/v1/schema.json`, `schema/v1/meta.json`, `schema/v2/schema.json`, `schema/v2/meta.json`, `docs/protocol/v1/*.mdx`, `docs/protocol/v2/*.mdx`, `docs/rfds/*.mdx`, `docs/rfds/v2/*.mdx`, plus the Rust canonical schema crate `agent-client-protocol-schema/src/v1/*.rs` and `src/v2/*.rs`.
- Raw schema files (verified accessible): https://raw.githubusercontent.com/zed-industries/agent-client-protocol/main/schema/v1/schema.json and .../main/schema/v2/schema.json; method-name constants: .../main/schema/v1/meta.json and .../main/schema/v2/meta.json.
