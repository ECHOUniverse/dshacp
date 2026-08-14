# DSH Extension Points — Fact Sheet

> Research-only fact sheet compiled from the DeepSeek Harness (DSH) source and docs.
> Primary sources: the local DSH checkout at
> `/Users/hanxu/.nvm/versions/node/v26.5.0/lib/node_modules/@deepseek-ai/dsh/`
> (published CLI package `@deepseek-ai/dsh` **0.1.0-rc.6**), plus the GitHub repo
> `deepseek-ai/deepseek-harness` (branch `master`) for packages not in the local install.
>
> **Headline**: DSH already ships an ACP server — `@deepseek-ai/dsh-acp`
> (repo `packages/acp/acp/`) — but it is **automation-only and deliberately narrow**.
> DSHACP's job is to widen that surface; the facts below are the raw material.

---

## 1. Plugin model (Cordis)

- A plugin is a module exporting `apply(ctx)` (function, object, or `Service` class form).
- Dependencies are declared with `export const inject = ['agents']` — Cordis waits until those
  services exist before running `apply`.
- Everything registered via `ctx` (events, services, tools, timers) is auto-disposed when the
  plugin's Fiber unloads; manual resources use `ctx.effect(() => cleanup)`.
- Services are provided by `Service` subclasses (`super(ctx, 'key')`) or `ctx.provide()`.
- **Postmortem to respect**: `docs/postmortem/0001-acp-default-export-drops-inject.md` —
  DSH plugins MUST use **named exports**; `inject` metadata is lost through default-export unwrapping.
- Tutorial: https://deepseek-harness.github.io/deepseek-harness/develop/basic/

### Loading stack
- `@cordisjs/plugin-loader` loads a `cordis.yml` as a top-level list of rows
  `{id, name, config, inject, disabled}`; `cordis:group` rows support `isolate` realms.
- `dsh-app-boot` provides `boot(binName, configPath)` → root context, `mountRootInclude`,
  `watchUserPatches`.
- A plugin row lives in one of three places:
  1. **Host / bundle composition** — an npm "bundle" declares
     `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`; profiles list bundles in
     `dsh.profile.bundles`. Shared core is `dsh-base/cordis.patch.yml`
     (`llm, session, agent, agent-loop, tools, approval, subagent, goal, workflow-worker-thread,
     typert*, session-persistence-jsonl, …`); the Web surface is `packages/bundle/web-app/cordis.patch.yml`
     (`api-gateway`, `webserver`, `web-startup`, …).
  2. **Agent preset** — a directory with one `agent.cordis.yml`, mounted once per process under a
     standing scope. Service rows inside a preset must sit in an `isolate` realm.
  3. **npm package** — named exports of Cordis plugins, resolved by the loader.

---

## 2. Key services a plugin can consume

| Capability | Service / ctx key (package) | Key API | Events |
|---|---|---|---|
| Agents | `ctx.agents` (AgentRegistry, `dsh-agent`) | `register/get/list/roots/setFactory`; `create({sessionId, meta:{cwd}, agentOptions})→AgentHandle`; `resume()`; `agent.inbox.append/claim`, `followup(msg)`, `steer()`, `inject()`, `cancel(cause)`, `whenIdle()` | `agent/created`, `agent/disposed`, `agent/status`, `agent/session-start`, `agent/pre-step`, `agent/request`, `agent/request-error`, `agent/turn-stopping`, `agent/error`, `agent/inbox/{inserted,claimed,discarded}` |
| Agent loop | `ctx.agentLoop` (`dsh-agent-loop`) | `create(id, options, meta)`, `resume(resumeSessionId)` | durable `turn/*`, `step/*` |
| Sessions | `ctx.sessions` (SessionStore, `dsh-session`) | `create/fork/get/list/flush`; `Session.append(type,data)`, `deriveMessages()`, `surface`, `events`, `header` | `session/event` (each append), `session/created/disposed` |
| Model route / LLM | `ctx.llm` (LlmRuntime, `dsh-llm`) | `registerAdapter`, `listProviders/listModels/resolveModelInfo/prepareCall`, `stream(options): AsyncIterable<StreamChunk>` | `llm/stream` (waterfall), `llm/adapters-updated` |
| Tool registry | `ctx.tools` (ToolRuntime, `dsh-tools`) | `register(ToolDefinition{name,description,parameters,output,execute})`, `get/schemas/guard/execute`, `presentAs(mode)`, `restrict()` | `tools/pre-execute` → guards → `tools/execute` → `tools/post-execute` → `finalizeContent` → `tools/result` |
| Approval stack | `ctx.approval` (`dsh-user-approval`; consume via `ctx.get`, not inject) | `request(req)` → `allowed-once\|rejected\|cancelled\|unavailable`; `setApprovalPolicy()` | `approval/request` (waterfall; answer by returning an outcome or `next()`), log-only `approval/asked`/`approval/decided` |
| Subagent registry | `ctx.subagents` (`dsh-subagent`) | `registerProvider`, `start(name, req)`, `startContinuable`, `followup`, `interrupt`, `listChildren`, `drainContinuableDescendants` | `subagent/start`/`subagent/end`, `subagent/provider-added/removed` |
| Goals | `ctx.goals` (`dsh-goal`) | `create/edit/pause/resume/complete/block/clear` with `GoalRef{id,revision}` CAS | `goal/change` (durable), `goal/changed` (live) |
| Workflow | `ctx.workflowEngine` (`dsh-workflow`) | `start(request)→WorkflowRun{id, result, cancel, dispose}` | `workflow/start\|end\|phase\|log\|agent-start\|agent-end` |
| Presets | `ctx.agentPresets` (`dsh-agent-presets`) | `list/resolve/mount/composeFrom/read/copy/remove` | `agent-preset/selected` |
| Wire/gateway | `ctx.apiProxy` (`dsh-host-apiproxy`), `ctx.typertGateway`/`ctx.remote` (`dsh-api-gateway`), `ctx.connection` (`dsh-client-connection`) | see §3 | `session/*` mux frames, `host/remote-event` |

### Streaming / turn events (durable, via `session/event`) — 12 variants

`turn/start {turn}` · `turn/end {turn, reason}` · `step/start {turn, step}` · `step/end` ·
`user/message {…UserMessage}` · `assistant/chunk {turn, step, chunk: StreamChunk}` (token-level;
includes `usage` chunk) · `assistant/message` (committed, with provider/model) ·
`tool/call {turn, step, callId, name, arguments}` · `tool/result` (surface) ·
`steering/message` · `todo/write` · `request/header`.

Live equivalents: `agent/status`, `agent/inbox/*`, `tools/result`.

### `ctx.llm.stream` chunk shapes (raw StreamChunk)

`block-start` · `text-delta` · `reasoning-delta` · `tool-call-delta` · `block-end` · `usage` · `finish`.
The committed artifact is `assistant/message` (blocks `text|reasoning|tool-call|tool-result`).

---

## 3. Existing wire-protocol mechanisms

### ACP — a full server already exists (repo only, not in local 0.1.0-rc.6)
- `@deepseek-ai/dsh-acp` at `packages/acp/acp/` — "Automation-only ACP server over JSON-RPC stdio".
- Implementation: plugin `name='acp'`, `inject=['agents']`; opens
  `ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))` via
  `@agentclientprotocol/sdk`'s `AgentSideConnection` (`packages/acp/acp/src/index.ts` ~L348–353).
- Surface: `initialize` (baseline-only prompts, no capabilities), `authenticate` (no-op),
  `session/new` (fresh agent via `ctx.agents.create`, `meta.cwd`), `session/prompt`
  (text + flattened `resource_link`, one in-flight per session, settles on whole-agent idle),
  `session/update` → `agent_message_chunk` per committed text block of `assistant/message`,
  `session/cancel`, `session/request_permission` (one-shot allow/reject for bridge-owned
  `approval/request` with a `callId`).
- Consumes `ctx.agents`, `session/event`, `agent/inbox/claimed`, `agent/error`, `approval/request`.
- **History**: originally an editor-UI bridge, deliberately trimmed to automation-only in
  `notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md`
  (no session load/list/delete, no commands/modes/plan/titles/human elicitation; committed text only).
- Client: `@deepseek-ai/dsh-subagent-acp` (`packages/subagent/subagent-acp/`) — out-of-process
  subagent provider (`initialize` → `newSession` → prompt → collect `agent_message_chunk`).
- Demo app: `@deepseek-ai/dsh-acp-demo` (`packages/examples/acp-demo/`, bin `dsh-acp-demo`),
  composition `examples/acp-agent/cordis.yml` (llm-deepseek + sandbox + approval + acp-demo +
  subagent + workflow + fs tools; **deliberately no stdout logger, no HMR**).

### MCP — client only
- `@deepseek-ai/dsh-mcp-client` (`packages/mcp/mcp-client/`) bridges external MCP servers into
  `ctx.tools.register()` as `mcp__<server>__<tool>`. **No MCP server exposing DSH exists.**

### Typert RPC (host↔client typed RPC)
- `dsh-typert-protocol/registry/loader`, `dsh-api-gateway` (`ctx.typertGateway` / `ctx.remote`),
  `dsh-api-remotes`, carrier `dsh-client-connection`. Unary methods only; streaming uses
  separate named-stream protocols.

### HTTP gateway / WebSocket downlinks (the Web client's wire)
- `dsh-host-apiproxy` (`packages/host/apiproxy/`): four-quadrant discriminated union over
  `POST /api/<method>` / response / SSE frame / `POST /api/respond`, echoing `rpcId`.
- Domains: `session.*` (`session.prompt`, `session.cancel`, `session.history`, `session.fork`,
  `session.models`, `session.search`), `subagent.*`, `goals.*`, `approvals.*`, `questions.*`,
  `command.*`, `skill.*`, `settings.*`, `credentials.*`, `llm.*`, `workspace.*`, `agentPreset.*`.
- Downlinks: `dsh-client-connection` opens WebSockets at `/api/events.mux` and `/api/events.host`
  (server→client only).

---

## 4. Can a plugin own process stdio / register a CLI mode?

**Yes — the official ACP bridge does exactly this.** `packages/acp/acp/src/index.ts` wraps
`process.stdout`/`process.stdin` directly inside `apply()`. Constraints that make it work:
- The composition must mount **no stdout logger and no HMR**.
- stdout is reserved for framed JSON-RPC; diagnostics go to **stderr**.
- It is a **separate entrypoint**, not the web server.

Entrypoints:
- The `dsh` launcher (`apps/cli`) only parses its own flags (`--profile`, `--patch`, dumps) and
  hands everything else to the booted **profile** (`$DSH_HOME/profiles/<name>`). Modes are
  profiles/bundles, not launcher subcommands (`dsh web`, `dsh --profile headless "task"`).
- `dsh-cmdline` provides `ctx.cmdlineArgs` + `ctx.appExit`.
- Standalone app bins: `dsh-acp-demo`'s `bin.ts` is a `#!/usr/bin/env node` script calling
  `boot()` from `dsh-app-boot` with `resolveConfigPath('./cordis.yml')`. An installed npm package
  can bring its own `bin` — this is the sanctioned way to add a new CLI surface.

---

## 5. Mapping tools + streaming onto an external wire protocol (proven seams)

- **Prompt input**: `agent.followup(createUserMessage({content:[{type:'text',text}], source:{kind:'user'}}))`.
- **Token-level streaming**: `ctx.llm.stream()` yields raw `StreamChunk`s; each is also durably
  logged as `assistant/chunk {turn, step, chunk}`. Committed artifact is `assistant/message`.
- **Tool calls/results**: durable `tool/call {turn, step, callId, name, arguments}` + surface
  `tool/result`; live pipeline `tools/pre-execute → … → tools/result`.
- **Turn completion**: `turn/end {turn, reason}` → ACP stopReason (official
  `turnEndToStopReason` codec: `completed→end_turn`, `max-tokens→max_tokens`,
  `aborted→end_turn`, `interrupted→cancelled`, `error/blocked→end_turn`).
- **Control**: `agent.cancel({kind:'user'})`; one-shot permissions via `approval/request` waterfall.

---

## 6. Packaging / install model

- **npm bundle** (`"dsh":{"bundle":{"patch":…}}` + `dsh.profile.bundles`) — rows present in every
  profile that lists the bundle; rows share the process (stdout unavailable).
- **Agent preset** — per-session agent-plane composition; appropriate for model-facing
  tools/prompt sections, **not** for a process transport.
- **Standalone npm app with its own bin** — the established pattern for a stdio-owning ACP server
  (`dsh-acp-demo`): own `cordis.yml` composition, own process, own `--config`.
- The ACP composition puts the model-facing rows (llm, sandbox, tools, approval, subagent,
  workflow) in the host plane of that composition; the bridge creates one agent per `session/new`.

---

## Primary source locations (to study during implementation)

- Repo: https://github.com/deepseek-ai/deepseek-harness (tree `packages/acp/`,
  `packages/examples/acp-demo/`, `packages/subagent/subagent-acp/`, `packages/mcp/mcp-client/`,
  `packages/host/apiproxy/`, `packages/api/gateway/`, `docs/subsystems/core.md`,
  `docs/subsystems/session.md`, `docs/persistence-catalog.md`, `docs/api-gateway.md`,
  `docs/subsystems/typert.md`, `examples/acp-agent/`,
  `notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md`).
- Local checkout (`…/@deepseek-ai/dsh/`): `config/agent-presets/standard/agent.cordis.yml`,
  `node_modules/@deepseek-ai/{dsh-agent,dsh-agent-loop,dsh-session,dsh-llm,dsh-tools,
  dsh-user-approval,dsh-subagent,dsh-goal,dsh-workflow,dsh-agent-presets,dsh-app-boot,dsh-cmdline,
  dsh-headless,dsh-host-apiproxy,dsh-api-gateway,dsh-client-connection,dsh-mcp-client,
  dsh-subprocess,dsh-base,cordis-plugin-loader}/README.md`, `dsh-base/cordis.patch.yml`.
- Tutorial: https://deepseek-harness.github.io/deepseek-harness/develop/basic/
