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
- `session/set_mode` — do not advertise modes.

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
- **Message ids**: `msg-<turn>-<step>` for assistant streams, `thought-<turn>-<step>` for
  reasoning, `usr-<seq>` for replayed user prompts.

### Phase 2 (P2)
- Structured exposure of `subagent` / `goal` / `workflow` as updates (e.g. map goal state or
  workflow phases onto `plan`/`session_info_update` or custom `_`-methods).
- First-class ACP surface for the `ssh` plugin (ssh_exec etc. as tool calls — likely already works
  via the generic tool path; formalize kind/args rendering).
- Evaluate `allow_always` (map to per-session approval-policy change semantics).

### Phase 3 (P3)
- Hybrid mode: optionally delegate **file write** to Zed via `fs/write_text_file`
  (gated on `clientCapabilities.fs.writeTextFile`) to get per-hunk diff review; everything else
  stays DSH-owned. Add opt-in config.

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
