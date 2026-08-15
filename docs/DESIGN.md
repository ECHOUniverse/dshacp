# DSHACP — Design & Implementation Plan

> Master handoff document. Everything needed to build DSHACP is here or linked from here.
> Companion fact sheets (research): `../ACP-fact-sheet.md`, `./zed-acp-integration-fact-sheet.md`,
> `./DSH-extension-facts.md`.

## 1. What this is

A DSH plugin + standalone binary that lets **Zed** drive **DSH** over the **Agent Client Protocol (ACP) v1**,
exposing DSH's full core capability set (prompt loop, streaming, tool calls, approval, plan, session resume)
so Zed is a first-class front-end for DSH.

**One-liner**: Zed (stdio ACP client) → DSHACP (independent agent spine) → DSH core services.

## 2. Architecture

```
Zed (agent panel, ACP v1 stdio client)
   │  spawns subprocess, cwd = project root, newline-delimited JSON-RPC on stdin/stdout
   ▼
dshacp (standalone bin, boot() from dsh-app-boot, own cordis.yml)
   ├─ ACP v1 stdio bridge (wraps process.stdout/stdin; no stdout logger, no HMR)
   ├─ DSH agent spine (llm + sandbox + tools + approval + subagent + workflow + persistence)
   └─ 1 ACP session  ↔  1 DSH session (via ctx.agents.create / resume)
```

Key facts driving this shape:
- Zed speaks **ACP v1 stable** only (`imports schema::v1`; pins `agent-client-protocol = "=2.0.0"`;
  does NOT enable `unstable_protocol_v2`). → DSHACP locks `protocolVersion: 1`.
- stdio is the only stable transport; stdout is reserved for JSON-RPC, logs go to stderr.
- The official `@deepseek-ai/dsh-acp` already proves a Cordis host plugin can own stdio and that a
  `dsh-app-boot` standalone bin is the right entrypoint — we reuse that pattern, not that code.

## 3. Non-goals (explicitly deferred)

- Delegating file/terminal ops to Zed (`fs/write_text_file`, `terminal/*`) — P3 hybrid mode.
- Zed's per-hunk "Review Changes" diff UI — requires fs delegation, so P3.
- `allow_always` / `reject_always` permission options — P2 evaluation.
- ACP `session/set_mode` / modes; elicitation; MCP client tools (`mcpServers` is received but ignored).
  **↳ Superseded by §12 (P4):** modes move to config options, elicitation and MCP forwarding land in P4b.
- Zed-side cross-restart persistence (that is Zed's own concern, not ours).

## 4. Decision record (final)

| # | Decision | Conclusion |
|---|---|---|
| Q1 | Topology | Same machine, local; transport swappable for future remote |
| Q2 | Capability split | DSH self-contained execution; hybrid/delegate-to-Zed is P3 |
| Q3 | Scope phasing | P1=core built-ins; P2=orchestration+plugins (ssh first); P3=hybrid |
| Q4 | Deliverable form | Cordis host plugin + `dsh-app-boot` standalone bin |
| Q5 | Approval | Must be pushed to Zed via ACP |
| Q6 | Render list | All: prompt echo / stream / tool call+result / approval / plan·mode / error |
| Q7 | Sessions | new + load/resume both; no Zed-side cross-restart persistence |
| Q8 | Capability boundary | Core built-ins first; plugins later |
| Q9 | Concurrency | Multi-session concurrent; 1 ACP session → 1 DSH session passthrough |
| Q10 | Keys | Reuse `~/.dsh` config; `authMethods` empty; no key injection |
| Q11 | Implementation | Build new from scratch; copy official stdio/boot skeleton only |
| Q12 | Streaming | Token-level (`agent_message_chunk` per text-delta) |
| Q13 | Thinking | Expose via `agent_thought_chunk` (standard kind) — in P1 |
| Q14 | Architecture | Independent agent spine (A) |
| Q15 | Approval buttons | `allow_once` + `reject_once` only |
| Q16 | Session mgmt | `list` + title update + `delete` all implemented |
| Q17 | todo→plan | Yes, minimal mapping (`priority` fixed `medium`) |
| Q18 | ACP version | **v1 stable**, `protocolVersion: 1` |
| Q19 | Approval fallback | Wait for Zed; on timeout (generous, configurable) or disconnect → reject (fail-closed) |
| Q20 | Diff review | Accept no-diff; file edits render as `tool_call` cards; no hybrid |

## 5. ACP v1 surface to implement

### Implement (client → agent)
`initialize`, `session/new`, `session/load`, `session/resume`, `session/list`, `session/delete`,
`session/close`, `session/prompt`, `session/cancel` (notification).

### Implement (agent → client)
`session/request_permission` (request), `session/update` (notification).

### Deliberately NOT implemented
- `authenticate` / `logout` — advertise `authMethods: []` ⇒ Zed must not call them.
- `session/set_mode` — do not advertise modes. **↳ Superseded by §12 (P4):** modes move to
  `select` config options (`category: "mode"`); `set_mode` stays unimplemented.

### `initialize` negotiation (response)
```jsonc
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": {},            // text is baseline, no image/audio/embeddedContext
    "sessionCapabilities": { "list": {}, "resume": {}, "close": {}, "delete": {} },
    "auth": {}                           // no logout
  },
  "authMethods": []
}
```
- Ignore Zed's `clientCapabilities.fs.{readTextFile,writeTextFile}` and `terminal` (self-contained).
- `session/new` receives `mcpServers` (required v1 param) — accept and ignore in P1.

## 6. Core mapping (DSH ↔ ACP v1)

| DSH source | ACP target |
|---|---|
| `session/new` | `ctx.agents.create({sessionId, meta:{cwd}, agentOptions})` |
| `session/load` | `ctx.agents.resume(resumeSessionId)` + replay full history via `session/update` |
| `session/resume` | `ctx.agents.resume` (no replay by default) |
| `session/prompt` | `agent.followup(createUserMessage(text))`, turn stays pending |
| `assistant/chunk` `text-delta` | `agent_message_chunk` (token-level, repeated) |
| `assistant/chunk` `reasoning-delta` | `agent_thought_chunk` |
| `tool/call` | `tool_call` (`kind` mapped, `status: pending`, `rawInput`) |
| `tool/result` | `tool_call_update` (`status: completed\|failed`, `rawOutput`) |
| `todo/write` | `plan` (entries; `priority` fixed `medium`, `status` from completion) |
| usage chunk | `usage_update` |
| `turn/end` `reason` | `stopReason` via official `turnEndToStopReason` codec |

**`stopReason` codec** (reuse official mapping):
`completed→end_turn` · `max-tokens→max_tokens` · `aborted→end_turn` · `interrupted→cancelled` ·
`error/blocked→end_turn`.

**Tool `kind` mapping** (implemented in `src/codec.ts#toolKindForName`):
`bash`/`terminal`/`ssh_*` → `execute` · `read` → `read` · `write`/`edit` → `edit` ·
`glob`/`grep`/`web_search`/`*search` → `search` · `subagent`/`subagent_fork`/`ralph`/
`send_message`/`list_agents` → `think` · everything else → `other`.

## 7. Approval bridge (the hard part)

DSH's `approval/request` is a **synchronous waterfall**; ACP's `session/request_permission` is an
**async request/response**. The bridge:

1. Intercept `approval/request` and **hold** it (do not return an outcome yet).
2. Emit `session/request_permission` with `toolCall` as the subject and options
   `[{optionId:"allow_once", kind:"allow_once"}, {optionId:"reject_once", kind:"reject_once"}]`.
3. Await Zed's response, then backfill DSH's waterfall:
   - `{outcome:"selected", optionId:"allow_once"}` → `allowed-once`
   - `{outcome:"selected", optionId:"reject_once"}` → `rejected`
   - `{outcome:"cancelled"}` → `cancelled`
4. **Fallback (fail-closed)**: on timeout (default **10 minutes**, configurable) or Zed disconnect
   → return `rejected`.
5. On `session/cancel`, any pending permission request MUST be answered `cancelled`.

## 8. Zed configuration

`settings.json` (Agent Settings → External Agents → Add Custom Agent):

```jsonc
{
  "agent_servers": {
    "DSH": {
      "type": "custom",          // REQUIRED — cc-acp README omits it; do not copy that example
      "command": "dshacp",
      "args": [],
      "env": {}                  // keys come from ~/.dsh, not here
    }
  }
}
```
- Zed sets `current_dir` = project root and passes project shell env; it injects no API keys for
  custom agents — compatible with Q10.

## 9. Phased execution plan

### Phase 0 — Repo setup & study ✅
- [x] Init package (package.json + bin + TS). Bin name **`dshacp`**.
- [x] Study official reference in `deepseek-ai/deepseek-harness`:
  `packages/acp/acp/src/index.ts` (stdio wiring + codec), `packages/examples/acp-demo/src/bin.ts`
  (boot entrypoint), `examples/acp-agent/cordis.yml` (composition shape).
- [x] Confirm ACP v1 SDK choice: `@agentclientprotocol/sdk@0.25.1` (the SDK used by the
  official bridge; `AgentSideConnection` dispatches the full v1 surface including the
  optional `loadSession`/`listSessions`/`resumeSession`/`closeSession`/`deleteSession`).

### Phase 1 (P1) — Core loop ✅ (implemented; e2e-tested against a real model)
1. [x] **Boot & transport**: standalone bin calling `boot()` from `dsh-app-boot`; `cordis.yml`
   composition with agent spine (`llm`, `sandbox`, `tools`, `approval`, `subagent`, `workflow`,
   `session-persistence-jsonl`) + ACP bridge; **no stdout logger, no HMR**; logs to stderr.
   - Acceptance: process starts, reads stdin, writes framed JSON-RPC to stdout only. ✅
2. [x] **initialize**: v1 handshake + capabilities per §5.
3. [x] **session/new**: create DSH agent with `cwd`; return `sessionId`. Map 1:1 to DSH session.
4. [x] **session/prompt + streaming**: `agent.followup`; subscribe `session/event`; emit
   `agent_message_chunk` (text-delta) and `agent_thought_chunk` (reasoning-delta).
   - Acceptance: token-level typing in Zed; thinking shown. ✅ (verified token-chunk stream)
5. [x] **Tool calls**: `tool/call` → `tool_call`; `tool/result` → `tool_call_update`; `kind` mapping §6.
   - Acceptance: every tool call + result renders as an expandable card in Zed. ✅
6. [x] **turn/end**: emit `stopReason` via codec; settle `session/prompt` response.
7. [x] **Approval bridge** per §7 (intercept → request_permission → backfill → fail-closed).
   - Acceptance: approval appears in Zed; allow/deny works; timeout/disconnect rejects. ✅
8. [x] **todo→plan + usage**: `todo/write` → `plan`; usage chunk → `usage_update`.
9. [x] **Session management**: `session/list`, `session_info_update` (title), `session/load`
   (resume + full replay), `session/resume`, `session/delete`, `session/close`, `session/cancel`.
   - Acceptance: Zed lists sessions by title, can resume and delete. ✅
10. [x] **Zed smoke test** — e2e suite drives the built bin with the official client SDK over
    stdio (the same path Zed uses); real-model tests run when `~/.dsh/.credentials.yaml`
    holds a DeepSeek key. The §8 config is documented in `../README.md`.

### Implementation notes (P1 decisions beyond the plan)

- **`mcpServers`** on `session/new`/`load`/`resume` is accepted and ignored (per §5);
  non-empty `additionalDirectories` is accepted with a log line.
- **User-message echo**: the live prompt turn does NOT echo the user message as
  `user_message_chunk` (Zed renders its own copy); `session/load` replay includes direct
  human prompts (`source.kind: 'user'`) only.
- **Replay** walks the durable log and feeds the same per-event emitter as live streaming,
  so replayed and live turns render identically; usage is replayed as a cumulative
  `usage_update`.
- **Persistence flush**: `session/close`/`session/delete` flush the durable log
  (`ctx.sessions.flush`) before disposal so `session/list` (which reads storage) and later
  loads see complete history. Empty (never-prompted) sessions have no artifact and vanish
  from the list after close.
- **Approval rejection** surfaces as a completed tool call whose `rawOutput` reports the
  refusal (the DSH tool presents rejection as a result, not a throw).
- **Permission `optionId`s** follow §7 literally: `allow_once` / `reject_once` (the
  `kind` field carries the same value; the official `dsh-acp` used hyphens, but the
  DESIGN table is the contract here).
- **`usage_update.used`** counts input + output + cache + thought tokens ("tokens in
  context"), accumulated session-wide.
- **Message ids**: `msg-<turn>-<step>` for assistant streams, `thought-<turn>-<step>` for
  reasoning, `usr-<seq>` for replayed user prompts.

### Phase 2 (P2) ✅ (implemented; e2e-tested against a real model)
- [x] **Structured exposure of `subagent` / `workflow` as updates**: workflow runs render as
  `plan` updates — `workflow/start` announces the run, `workflow/phase` becomes a progress
  group, each `agent()` call becomes a task entry that flips to completed when it settles
  (non-clean outcomes annotated in the label), and `workflow/end` reports the stop reason.
  Subagent runs render as brief start/completed plan entries (non-`completed` stop reasons
  annotated). Run→session correlation prefers the initiator boundary when the event chain
  still carries it (exact attribution); otherwise it uses the pending-turn owner — and only
  when **exactly one** session has a turn in flight, so concurrent sessions can never
  misattribute a plan update. Note: the public `subagent/start`/`subagent/end` events carry
  only `(info)` — no parent agent — so correlation cannot use a parent reference.
  `goal` is **not** exposed: the composition mounts no goal domain (P1 spine skips it), so
  there is no goal state to map — revisit if goals are enabled.
- [x] **First-class ACP surface for the `ssh` plugin**: `@linxin666/dsh-ssh` is mounted in
  `cordis.yml`; the app provides a no-op `webServer` stub (this process serves no HTTP, so
  the plugin's route/upgrade registrations are discarded) while the SSH engine, model tools
  (`ssh_list`/`ssh_exec`/`ssh_upload`/`ssh_download`/`ssh_tunnel`/`ssh_cluster`), and prompt
  announcement work normally. Host config stays in `~/.dsh/dsh-ssh.json`, shared with the
  web app. Tool `kind` mapping already routes `ssh_*` → `execute` (verified: `ssh_list`
  renders as an `execute` tool-call card).
- [x] **`allow_always` evaluated and implemented**: maps to per-session, per-tool semantics.
  Choosing `allow_always` grants the current call and records the tool name in the session's
  allowlist; later calls of that tool resolve `approval/request` to `allowed-once` without a
  push. The DSH approval policy itself stays `ask` — the allowlist lives in the bridge,
  scoped to one ACP session, and is not a durable grant.

### Phase 3 (P3) ✅ (implemented, opt-in; e2e-tested)
- [x] **Hybrid mode**: opt-in via `hybridFileWrites` (env `DSHACP_HYBRID=1` in the shipped
  composition). Gated on `clientCapabilities.fs.writeTextFile` at `initialize`. When active,
  the agent's `write` tool is shadowed by a per-agent scoped tool (DSH's scoped
  registrations shadow globals) that delegates to `fs/write_text_file` — Zed applies the
  edit to its buffers and offers per-hunk diff review. Everything else stays DSH-owned.
  Relative paths resolve against the session cwd (the ACP wire requires absolute paths).
  `edit` stays local (delegation would require read+transform+full rewrite; revisit if Zed's
  diff UX demands it).

## 10. Defaults & open tunables (pick during implementation)

- **Bin name**: `dshacp` (chosen).
- **Install**: standalone npm package exposing the bin; Zed `command: "dshacp"`.
  The bin defaults to the `cordis.yml` shipped inside the package; `--config` overrides.
- **Model**: composition default `deepseek-official` / `deepseek-v4-flash` (row `llm-deepseek`
  in `cordis.yml`); `session/new` may override provider/model through the app config
  (currently optional — absent reuses the composition default).
- **Approval timeout default**: 10 minutes (`approvalTimeoutMs`), fail-closed.
- **Tool `kind` mapping**: implemented in `src/codec.ts` (see §6).

## 11. Primary sources

- ACP spec: https://agentclientprotocol.com · repo https://github.com/agentclientprotocol/agent-client-protocol
  (schema `schema/v1/schema.json`, `schema/v1/meta.json`).
- Zed external agents: https://zed.dev/docs/ai/external-agents
- DSH: https://deepseek-harness.github.io/deepseek-harness/develop/basic/ ·
  https://github.com/deepseek-ai/deepseek-harness
- Local DSH checkout: `/Users/hanxu/.nvm/versions/node/v26.5.0/lib/node_modules/@deepseek-ai/dsh/`
- Full fact sheets (research): `../ACP-fact-sheet.md`, `./zed-acp-integration-fact-sheet.md`,
  `./DSH-extension-facts.md`.

---

## 12. Phase 4 (P4) — DSHACP as a thin ACP bridge over `dsh-base` + presets

> **Supersedes §3/§5**: the "no `session/set_mode`, no modes, no elicitation, MCP ignored"
> stances are replaced below. Research: `./P4-acp-config-and-dsh-presets.md`.

### 12.1 Goal

Make Zed a first-class DSH front-end that **inherits DSH's configured surface** instead of
re-implementing it: (1) switch model / thinking strength / agent mode directly in the Zed panel;
(2) slash commands that invoke skills; (3) all of DSH's tools — skills, tools, MCP, and plugin
user-tools — available to the model, owned by DSH's own configuration.

### 12.2 Architecture

```
Zed (ACP v1 stdio)
   ↓
dshacp (headless composition, boot dsh-app-boot)
   ├─ dsh-base/cordis.patch.yml                ← official host core: registries + sandbox/approval + ALL tools
   ├─ disable the base agent-plane tool rows    ← the web-app's disable list (see below)
   ├─ dsh-agent-presets { default: standard }   ← per-session preset (standard/cordis/code/minimal = the modes)
   ├─ dsh-mcp-client                            ← DSH-side MCP config
   ├─ ssh (and other plugin user-tools, host-plane)
   └─ ACP bridge (the only bespoke surface): sessions / streaming / approval /
       config options / slash commands / elicitation / MCP forwarding
   └─ NOT mounted: api-gateway, webserver, web-runtime, ui-* (headless; stdout = JSON-RPC)
```

The key discovery driving this: `dsh-base/cordis.patch.yml` already ships every tool
(`tool-goal`, `plan-mode`, `tool-web`+`web`/`web-search-deepseek`, `tool-fs-search`,
`user-questions`/ask-user, subagent family, workflow, ralph, todo, str-replace-editor,
compaction, spill, …); the web app makes them per-session by disabling the base agent-plane rows
and mounting `dsh-agent-presets`. DSHACP's current `cordis.yml` + `spineComposition` is a partial,
drifting copy that omits presets entirely — this is why "DSH's configured tools/modes" were
unavailable. Phase 4 replaces that copy with the real thing.

### 12.3 Decision record (final)

| # | Decision | Conclusion |
|---|---|---|
| D1 | Scope | Model + thinking strength + agent mode + slash commands, all in P4 |
| D2 | Architecture | Rebuild on `dsh-base` + `dsh-agent-presets`; refactor-first, features-after |
| D3 | Model / thinking / mode UX | `select` config options (`category` `model` / `thought_level` / `mode`) |
| D4 | Slash commands | `available_commands_update` |
| D5 | UX contract | Zed ACP native (dropdowns + `/` menu); no fake native model picker |
| D6 | Value source | Dynamic enum (`llm.listModels`+`resolveModelInfo.reasoning.efforts`; `agentPresets.list`) |
| D7 | Defaults | Zed `default_config_options` authoritative; mode default via config-option id (not `default_mode`) |
| D8 | Model↔thinking linkage | Switching model resets thinking to that model's `defaultEffort`, resends full `configOptions` |
| D9 | Mode lock | Blank-session `recompose`; non-blank → soft-reject (return old value + stderr), no exception |
| D10 | Slash catalog | Only `userInvocable` skills; no plugin/basic/subagent-family tools |
| D11 | Goal | Mounted via base+preset; exposed to the model (`get_goal`/`create_goal`/`update_goal`) |
| D12 | MCP | Both: DSH-side `dsh-mcp-client` + Zed-forwarded `mcpServers` merged |
| D13 | Full toolset | `web_search` ✅ · `ask_user_question` ✅ (needs ACP elicitation) · `plan-mode` ✅ |
| D14 | Persistence | Model/thinking in `request/header`; mode in `agent-preset/selected`; resume restores for free |

### 12.4 ACP bridge changes

1. **`initialize`**: advertise `mcpCapabilities: { http: true }` (http forwarding into
   `dsh-mcp-client`; stdio is mandatory per the spec and has no capability field; sse/acp are
   not advertised and are skipped with a diagnostic when a client sends them anyway).
   Elicitation has no agent-side capability field in the SDK — the gate is the client's
   `clientCapabilities.elicitation.form`, captured at initialize.
2. **`session/new`**: `setup(agentCtx)` mounts the preset (`agentPresets.mount(agentCtx, id)`,
   id resolved from the session: the creation header for fresh sessions, the loaded log's last
   `agent-preset/selected` for resume); return `configOptions` (three `select` options:
   model / thinking / mode); after creation push `available_commands_update`
   (`userInvocable` skills); await `mcpServers` forwarding. `session/load` and `session/resume`
   return `configOptions` the same way.
3. **`session/set_config_option`** (implemented `setSessionConfigOption`):
   - model/thinking → validate via `llm.resolveCallConfig` → set `ModelSelectionRef.current`
     (`installModelSelection` installed per record after creation); on model change reset
     thinking to that model's `defaultEffort`.
   - mode → blank-session `agentPresets.recompose` (+ durable `agent-preset/selected` event),
     else soft-reject (return the unchanged list + stderr warn).
   - always respond with the **complete** `configOptions` list.
4. **`session/set_mode`**: not implemented (config options supersede modes; Zed ignores modes
   when options are present).
5. **Slash `/name`**: the catalog is `ctx.skills.list({cwd, scope: agent})` filtered to
   `userInvocable` → `available_commands_update`; invocation needs no bridge code — the
   preset's `tool-skill` pre-step hook already injects `renderSkillContent(skill)` for `/name`
   gestures (deterministic skill run). `skills/change` refreshes every live session's catalog.
6. **MCP**: `session/new.mcpServers` (and load/resume) are forwarded into `dsh-mcp-client`
   plugin instances, keyed by raw server name and mounted once process-wide (DSH's MCP model
   is composition-global); a failed or unsupported server is logged and skipped, never failing
   the session; mounts unwind at quiesce.
7. **Keep**: token streaming, reasoning chunks, tool-call cards, approval bridge, session
   management (list/load/resume/delete/close/cancel), P3 hybrid `write`.
8. **Elicitation**: the bridge registers the single `ctx.userQuestions` provider; `ask()`
   maps `AskUserQuestionItem[]` to a form `requestedSchema` and races
   `unstable_createElicitation` against the tool call's abort signal and
   `elicitationTimeoutMs` (default 30 min, fail-closed). Decline/cancel/timeout fail the tool
   call closed through the ordinary result pipeline; a client without `elicitation.form` gets
   `CLIENT_UNSUPPORTED`.

### 12.7 P4 implementation notes (beyond the plan)

- **The user's DSH configuration is inherited wholesale** — including `permission.defaultPreset`
  from `~/.dsh/settings.yaml`: `dsh-permission-presets` pins every fresh session's
  `sandbox/mode` + `approval/policy` events from the user's chosen preset, exactly as the web
  app does. A user who configured `danger-full-access` gets unconfined sessions (no approval
  pushes); the e2e suite isolates from the host machine by running under a temporary
  `DSH_HOME` that pins `workspace-write`.
- **`agentPresets` roster roots**: the shipped root is `@deepseek-ai/dsh/config/agent-presets`
  (the same assembly fact the web app uses), resolved by `lib/bin.js` and exposed to the
  `agent-presets` row's `!!js` expression via a boot-provided value; the user root
  (`<dshHome>/.agent-presets`) is appended automatically.
- **Model selection seeding**: the `dshacp` row's optional `provider`/`model` still seed each
  session's selection; absent that, the fallback chain is the session's `request/header`
  (resume restore) then `agent-default-model` (composition default + settings).
- **Model option values** are `provider:model` — model ids are not unique across providers
  (deepseek-v4-flash may exist on several routes), so a bare id would collide in the client
  picker and the current value would highlight every option carrying it. The catalog is
  grouped by provider when more than one route is live; `set_config_option` accepts the
  qualified value (what the picker sends) or a bare model id (a legacy
  `default_config_options` entry), resolving a bare id to the single owning provider or — when
  several own it — keeping the current provider, and rejecting only when the current provider
  does not own it. The model branch validates through `llm.resolveCallConfig` (the web
  picker's exact mechanism) and reads the target model's metadata for the D8 thinking reset; a
  target without an adapter `defaultEffort` pins the first offered effort so the stored
  selection and the displayed option always agree.
- **`thought_level` is conditional**: the option is emitted only when the current model
  exposes reasoning efforts (a non-reasoning model gets model + mode only) — Zed renders
  exactly the options it receives, and a selector over a non-existent knob would be noise.
- **DSH-side MCP (D12 "both")**: the DSH-configured half is ordinary composition — a
  deployment adds `@deepseek-ai/dsh-mcp-client` rows to its own `--config` leaf (the same
  model the web app uses); the Zed-forwarded half is the dynamic `mcpServers` mounting in
  the bridge. Both register into the same `ctx.tools` registry under `mcp__<server>__<tool>`.
- **Tool-kind mapping for MCP tools**: `mcp__*` names fall through `toolKindForName` to
  `other` (the rule-based tail) — a forwarded MCP tool renders as a generic tool card.

### 12.5 Implementation order (refactor-first)

- **P4a — refactor** ✅ (implemented; e2e-tested): `cordis.yml`/`spineComposition` replaced with
  `dsh-base` + the web-app's disable list (`dshacp.patch.yml`) + `dsh-agent-presets`
  (+ `dsh-mcp-client`); the now-duplicated spine rows are deleted; the ACP bridge and ssh
  survive; the e2e suite re-runs green; headless verified (no bound port, stdout pure).
  `lib/bin.js` resolves the `dsh-base/cordis.patch.yml` bundle patch and the shipped overlay
  through `boot()`'s patches parameter; the shipped preset root (`@deepseek-ai/dsh/config/
  agent-presets`, the same root the web app uses) is exposed to the `agent-presets` row
  through a boot-provided value.
- **P4b — features** ✅ (implemented; e2e-tested): (1) config options (model/thinking/mode) →
  (2) slash commands → (3) MCP forwarding → (4) ACP elicitation for `ask_user_question`.

### 12.6 Risks

- **Base-vs-spine overlap** ✅ resolved: the spine copy is gone; `dsh-base` is the one source of
  the host core, and the disable list mirrors `dsh-web-app`'s so a reordered base cannot
  silently resurrect agent-plane rows.
- **Headless constraint** ✅: no webserver/HMR; stdout reserved for JSON-RPC (verified by the
  e2e suite, which drives the built bin over stdio).
- **Elicitation** ✅ implemented last, as planned; the single `userQuestions` provider slot is
  the bridge's, and the gate is the client's advertised capability.
- **Existing e2e** ✅ re-verified after the refactor; the harness now runs under an isolated
  `DSH_HOME` so the host machine's DSH settings cannot decide behavior under test.
