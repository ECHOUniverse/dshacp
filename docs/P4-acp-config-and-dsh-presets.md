# P4 Research — ACP v1 config options / slash commands & DSH runtime knobs

> Research-only fact sheet for DSHACP Phase 4 ("make Zed a first-class DSH front-end that
> inherits DSH's configured tools and modes"). Compiled from the local DSH checkout
> (`/Users/hanxu/.nvm/versions/node/v26.5.0/lib/node_modules/@deepseek-ai/dsh/`, dsh 0.1.0-rc.6),
> the installed `@agentclientprotocol/sdk@0.25.1`, the ACP spec repo, and Zed source.
> CONFIRMED = read directly from source; INFERRED = derived. No files modified by the research.
>
> This sheet supersedes the "modes deliberately not implemented" notes in `DESIGN.md` §3/§5
> and `README.md`. The plan it feeds is `DESIGN.md` §12 (Phase 4).

---

## 1. Headline

DSHACP today is a **hand-rolled agent spine** that re-declares a *drifting subset* of DSH's
tools and does not mount DSH's agent presets. DSH already ships the whole host core
(`dsh-base/cordis.patch.yml`) and the preset mechanism (`dsh-agent-presets`). Phase 4 rebuilds
DSHACP as a **thin ACP bridge over `dsh-base` + `dsh-agent-presets`**, so it inherits every
configured tool (skills, tools, MCP, plugin user-tools) and the standard/creative/code/minimal
modes for free — instead of re-implementing them.

---

## 2. ACP v1 — config options, modes, slash commands (exact wire schema)

### 2.1 `AgentCapabilities` has **no** modes/configOptions/availableCommands

`InitializeResponse.agentCapabilities` (`types.gen.d.ts:53–113`) carries only: `auth`,
`loadSession`, `mcpCapabilities`, `nes`, `positionEncoding`, `promptCapabilities`, `providers`,
`sessionCapabilities`. Modes and config options are **per-session**, declared in the
session-setup responses; slash commands are pushed only via a `session/update` notification.

```ts
export type NewSessionResponse = {           // types.gen.d.ts:3272; same shape on Load/Fork
  configOptions?: Array<SessionConfigOption> | null;  // "Initial session configuration options"
  modes?: SessionModeState | null;                    // "Initial mode state"
  sessionId: SessionId;
};
```

### 2.2 Config options (the mechanism Phase 4 uses for model / thinking / mode)

```ts
export type SessionConfigOption =
  | (SessionConfigSelect & { type: "select" })
  | (SessionConfigBoolean & { type: "boolean" })
  & { category?: SessionConfigOptionCategory | null; description?: string | null;
      id: SessionConfigId; name: string };           // types.gen.d.ts:4275

export type SessionConfigSelect = {                  // 4322
  currentValue: SessionConfigValueId;                // string
  options: SessionConfigSelectOptions;               // Array<Option> | Array<Group>
};
export type SessionConfigSelectOption = { description?: string | null; name: string; value: SessionConfigValueId };
export type SessionConfigSelectGroup = { group: SessionConfigGroupId; name: string; options: Array<SessionConfigSelectOption> };
export type SessionConfigBoolean = { currentValue: boolean };
```

- `type` is a **discriminator with exactly `"select" | "boolean"`** — no string/number/enum variant
  (confirmed against the canonical spec repo schema's `oneOf`).
- `category` (UX-only): SDK 0.25.1 enum = `"mode" | "model" | "thought_level" | string`
  (`types.gen.d.ts:4318`). ⚠️ the live spec repo additionally defines `"model_config"`; the SDK
  enum predates it. The TS type is open (`| string`) so it still validates.
- `"select"` is supported by default by all clients; `"boolean"` only if the client advertises
  `clientCapabilities.session.configOptions.boolean` (Zed does).

Wire methods:

```ts
export type SetSessionConfigOptionRequest =          // 4716
  ({ type: "boolean"; value: boolean } | { value: SessionConfigValueId })   // select variant has NO "type"
  & { configId: SessionConfigId; sessionId: SessionId };
export type SetSessionConfigOptionResponse = { configOptions: Array<SessionConfigOption> }; // 4750 — always the COMPLETE list
```

Agent → client: `SessionUpdate` variant **`config_option_update`** → `ConfigOptionUpdate`
(`types.gen.d.ts:788`), payload `{ configOptions: Array<SessionConfigOption> }` — also the complete
state. Agent may send it any time (autonomous change, model fallback, discovered context).

### 2.3 Modes — **deprecated** in favor of config options (category `"mode"`)

```ts
export type SessionMode = { description?: string | null; id: SessionModeId; name: string };  // 4530
export type SessionModeState = { availableModes: Array<SessionMode>; currentModeId: SessionModeId }; // 4552
export type SetSessionModeRequest = { modeId: SessionModeId; sessionId: SessionId };          // 4769
```

Live spec: *"Session Config Options are the preferred way… If an Agent provides `configOptions`,
Clients SHOULD use them instead of `modes`. Modes will be removed in a future version."*
Notification is `current_mode_update` → `{ currentModeId }` (canonical schema + SDK zod use
`currentModeId`; the live docs example showing `modeId` is stale).

**Phase 4 decision: return `configOptions` only; do NOT return `modes`.** Zed skips its legacy
mode/model selectors whenever `configOptions` is present, so modes are a second source of truth
with zero benefit here.

### 2.4 Slash commands — `AvailableCommandsUpdate` only (no session-setup field)

```ts
export type AvailableCommandsUpdate = { availableCommands: Array<AvailableCommand> }; // types.gen.d.ts:448
export type AvailableCommand = { description: string; input?: { hint: string } | null; name: string }; // 415
```

Pushed via `session/update` after session creation; may be resent for dynamic updates. **Invocation
has no dedicated method** — the client sends a normal `session/prompt` whose text is
`/name rest-of-input`; the agent recognizes the `/` prefix. `input.hint` is the placeholder.

### 2.5 Zed rendering (confirmed from Zed `main` source)

- **Select config option** → `PickerPopoverMenu` dropdown (searchable above a threshold); trigger
  shows `currentValue` + chevron; tooltip + keybindings by category:
  `model` → "Change Model"/"Cycle Favorite Models", `thought_level` → "Change Thinking Effort",
  `mode` → "Change Mode"/"Cycle Through Modes".
- **Boolean config option** → `Switch` toggle.
- **Config options take precedence**: if `configOptions` is present Zed creates *no* mode selector
  and *no* model picker (`conversation_view.rs` 1290–1330).
- **Available commands** → "/" completion in the message editor.
- **No model picker for external ACP agents** (`AgentConnection::model_selector` returns `None`
  for `AcpConnection`; only the in-process native agent implements it). `parameterizedModelPicker`
  meta is Cursor-only. ⇒ model selection for DSHACP must be a `category: "model"` select option.

### 2.6 SDK dispatch + version skews

- SDK `@agentclientprotocol/sdk@0.25.1`, `PROTOCOL_VERSION = 1`. Agent handler interface (optional
  methods, dispatched from `session/set_mode` / `session/set_config_option`):
  `setSessionMode?(params)`, `setSessionConfigOption?(params)`; agent→client is the single generic
  `sessionUpdate(params: SessionNotification)`.
- Skews to respect: SDK `SessionConfigOptionCategory` lacks `"model_config"`; live docs mode example
  uses stale `modeId` (use `currentModeId`).

---

## 3. DSH runtime knobs — model, thinking strength, agent mode

### 3.1 Model selection (runtime, per-session)

- `ctx.llm` (`LlmRuntime`): `listProviders()`, `listModels(provider)`, `resolveModelInfo(provider,
  model)` (adds `reasoning?: { efforts: {id,name,description?}[], defaultEffort? }`),
  `resolveCallConfig(config)` (validates effort; throws `UNSUPPORTED_REASONING_EFFORT`), `stream()`.
- Canonical per-session mutable selection: **`installModelSelection(agentCtx, selection)`** from
  `@deepseek-ai/dsh-agent` (exported at its index; `ModelSelectionRef = { current, assembled }`).
  Installs `system-prompt/assemble` + `agent/request` listeners that apply
  `{ provider, model, reasoningEffort }` per step. **This is what the web GUI and dsh-headless use.**
- Alternative seam: `agent/request` waterfall (`Scoped<Agent>`), return a replacement
  `LlmCallConfig`; never mutate the frozen config.
- Effective config is logged in `request/header` (`reason: initial|resume|change`); restored on
  resume via `session.requestHeader()`.
- Default route: `agent-default-model` service, settings ns `agent-default-model`.

### 3.2 Thinking strength = DeepSeek `reasoning_effort` (NOT low/medium/high)

`@deepseek-ai/dsh-llm-deepseek` (route `deepseek-official`) config: `thinking: 'enabled' |
'disabled'`, **`reasoningEffort: 'off' | 'high' | 'max'`** (`REASONING_EFFORTS` = Off/High/Max;
`off` = thinking disabled). `high`/`max` → body `{ thinking:{type:'enabled'}, reasoning_effort }`;
`off` → `{ thinking:{type:'disabled'} }` and `reasoning_effort` omitted.

- Changeable at runtime: per-session via `ModelSelection.reasoningEffort` / `agent/request`;
  deployment default via `ctx.settings.update('llm-deepseek', { reasoningEffort })` (hot, next request).
- The catalog's authoritative efforts come from `resolveModelInfo(model).reasoning.efforts`.
- Default catalog ships `deepseek-v4-flash` + `deepseek-v4-pro`.

### 3.3 Agent mode = agent preset (no `mode` field on Agent/AgentLoop)

`config/agent-presets/` ships four presets (each = an AGENT-plane `agent.cordis.yml` + `preset.yml`):

| id | preset.yml name | meaning |
|---|---|---|
| `standard` | 标准模式 | full coding agent |
| `code` | PTC 模式 | standard + tool-presentation `mode: code` |
| `minimal` | 极简模式 | persistent-shell + filesystem only |
| `cordis` | 创造模式 | standard + `tool-cordis` + preset-authoring skills |

`ctx.agentPresets` (`@deepseek-ai/dsh-agent-presets`): `list()`, `resolve(id?)`, `mount(agentCtx,
id?)` (factory `setup` hook is the call site), **`recompose(agentCtx, id)`** (runtime switch,
**valid only while the agent has produced nothing — caller owns the blank check**),
`resolveSessionPreset(session)`. Non-blank switch → `agent-preset-locked` (blank = no `turn/start`
yet). Durable event `agent-preset/selected {agentPreset}`; re-emitted live as
`agent-preset/selected(sessionId, agentPreset)`.

| Knob | Changeable mid-session? | Mechanism | Durable? |
|---|---|---|---|
| Model | Yes | `ModelSelectionRef.current` / `agent/request`; next step | Yes — `request/header` |
| Thinking | Yes | same seams + settings ns `llm-deepseek` | Yes — `request/header` |
| Agent mode | **Blank-only** | `agentPresets.recompose` | Yes — `agent-preset/selected` |

### 3.4 Web GUI reference wiring (the pattern Phase 4 copies)

- `session.models {sessionId}` → `{ current, routable, groups:[{id,name,models:[{id,name,reasoning:{efforts,defaultEffort}}]}] }`;
  `session.selectModel {sessionId, provider, model, reasoningEffort?}` → `resolveCallConfig` →
  `selectionFor(agent).current = selected` → save default.
- `agentPreset.list {}` → `{ presets, authorable }`; `agentPreset.select {sessionId, agentPreset}`
  (blank-only) → `recompose` → append `agent-preset/selected`.
- `session.create { workspaceId?|cwd?, agentPreset? }` (mode at creation).

---

## 4. Skill + tool enumeration & deterministic dispatch

### 4.1 Skills — `ctx.skills` (`@deepseek-ai/dsh-skill`, key `"skills"`)

```ts
list(options?: { cwd?, signal?, scope? }): Promise<SkillSummary[]>
snapshot(...): Promise<{ skills, complete }>
get(name, options): Promise<SkillDefinition | undefined>   // full body incl. .content
register(skill): () => void
registerProvider(create): () => void
```

`SkillSummary = { name (kebab), description, whenToUse?, invocation: { modelInvocable, userInvocable },
source, provider, resourceBase? }`. `SkillDefinition.content` = full instruction Markdown;
`renderSkillContent(skill)` renders the canonical `<skill_content>` block. Sources/roots (rank
order): project `.dsh/skills` (100) · project `.agents/skills` (200) · `customSkillDirs` (300) ·
`~/.dsh/skills` (400) · `~/.agents/skills` (500) · `$DSH_BUNDLED_SKILL_DIR` (600). Event
`skills/change`.

**Phase 4 slash commands expose only `invocation.userInvocable` skills** (mirrors the web GUI's
user-triggerable set). Deterministic skill invocation = `ctx.skills.get(name, {scope:agent})` then
inject `renderSkillContent(skill)` as a user message (the `dsh-tool-skill` package's `agent/pre-step`
listener already does the same for `/name` gestures).

### 4.2 Tools — `ctx.tools` (`@deepseek-ai/dsh-tools`, key `"tools"`)

- `schemas(scope?)`: `ToolSchema[]` = `{ name, description, parameters }` (visible tools for scope).
  **No category/hidden/visibility field** — distinguishing "basic" tools from capability tools is
  by name-set only.
- `get(name, scope?)`: full `ToolDefinition`.
- `execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>` — the **supported** programmatic
  path; runs the full pipeline (pre-execute waterfall → approval if `ask` → guards → body →
  post-execute → materialize → `tools/result`). `ToolExecutionInput = { callId: CallId(id), name,
  arguments, agent?, signal }`. Approval with no agent ⇒ auto-deny. Errors materialize as
  `{ isError:true }` results (never throw); unknown tool → `UNKNOWN_TOOL`.
- `get(name).execute(args, ctx)` bypasses policy/validation — not supported.

### 4.3 Registered tool names (for the slash catalog / exclusions)

- SSH (`@linxin666/dsh-ssh` v0.1.10, host-plane, all `ctx.tools.register`): `ssh_list`, `ssh_exec`,
  `ssh_upload`, `ssh_download`, `ssh_tunnel`, `ssh_cluster`.
- Goal (`dsh-tool-goal`, injects `agents/goals/tools/systemPrompt`): `get_goal`, `create_goal`,
  `update_goal` (no tool named `goal`).
- Subagent family: `subagent` (spawn, continuable), `subagent_fork` (fork, one-shot),
  `send_message` + `interrupt_agent` (control), `list_agents` (control/list-agents), `report`
  (continuable children only).
- `workflow` (dsh-tool-workflow), `ralph` (dsh-tool-ralph).

---

## 5. dsh-base / dsh-web-app / dsh-headless — the composition analysis that drives the refactor

### 5.1 `dsh-base/cordis.patch.yml` = the full host core (already ships every tool)

Applied as ONE insert over the empty profile root. Contains, in one place: registries (`llm`,
`session`, `typert*`, `session-title(+llm)`, `user-questions`, `agent`, `agent-default-model`,
`jobs`, `skill`, `tools`, `goal(+round-driver+command)`, `subagent(+spawn/fork backends)`,
`workflow-worker-thread`, `web(+search provider)`, `session-projection`) + sandbox/approval/
`permission-presets` + persistence/compaction/spill/telemetry + **all the model-facing tool rows**
(`tool-bash`, `tool-pwsh`, `tool-jobs`, `tool-fs`, `tool-fs-search`, `tool-skill`, `tool-goal`,
`plan-mode`, `tool-subagent*`, `tool-workflow`, `tool-ralph`, `tool-todo`, `tool-web`,
`tool-str-replace-editor`, `repeat-tool-reminder`, `command-*`, compaction/pruner) + the adapters
(`llm-deepseek`, dormant `llm-pi-ai`) + `fs-sandbox`/`fs-observation-policy`.

⇒ **This is the "全部工具" the user wants, already assembled by DSH.** DSHACP's current
`cordis.yml` + `spineComposition` is a partial, drifting copy of it.

### 5.2 `dsh-web-app/cordis.patch.yml` = the preset-driven surface (the pattern to copy)

Applied after base. It (a) overrides a few base rows (`system-prompt` persona, `hmr` disabled,
`session-query-sqlite`, `tools` mode), (b) inserts web-only transport/UI rows, and (c) — the key —
**disables the base's agent-plane tool rows and mounts `dsh-agent-presets`** so each session
composes its agent from a preset instead of the process-wide base rows:

```
# every row below = what ONE agent contributes; disabled here, owned by a preset instead:
tool-bash, tool-pwsh, tool-jobs, tool-fs, tool-fs-search, tool-str-replace-editor,
skill-filesystem, tool-skill, tool-goal, plan-mode, compaction-basic, command-compact,
tool-result-pruner, tool-subagent-control, tool-subagent-list-agents, tool-subagent,
tool-subagent-fork, workflow-worker-thread, tool-workflow, tool-ralph, agent-instructions,
tool-todo, tool-web
- insert:
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config: { default: standard }
```

Host-plane rows that MUST stay host-plane (per the patch's own notes): `shell-env`, the job/goal/
subagent/workflow/tool **registries**, `token-meter`, `tool-subagent-report` (continuable setup is
not scope-aware).

### 5.3 `dsh-headless/cordis.patch.yml` = one-shot mode over base (no Host/HTTP/Web/browser)

Overrides `system-prompt` persona, disables `hmr`, sets `tools` mode, and inserts
`code-runtime` + `headless-startup` + `headless-runner`. Proof that a headless composition can
stand on `dsh-base` with no web transport — the same constraint DSHACP has (stdio owns stdout).

### 5.4 Conclusion for the refactor

DSHACP should become: **`dsh-base` insert + the web-app's "disable agent-plane tools" list +
`dsh-agent-presets` (`default: standard`) + `dsh-mcp-client` + ssh + the ACP bridge** — and must
NOT insert the web-app's transport/UI rows (`api-gateway`, `webserver`, `web-runtime`, `ui-*`).
The ACP bridge is the only bespoke surface; everything else is DSH's own configuration, inherited.

---

## 6. Primary sources

- Local DSH checkout `…/@deepseek-ai/dsh/` (0.1.0-rc.6): `node_modules/@deepseek-ai/dsh-base/
  cordis.patch.yml`, `dsh-web-app/cordis.patch.yml`, `dsh-headless/cordis.patch.yml`,
  `config/agent-presets/{standard,cordis,code,minimal}/agent.cordis.yml`, and
  `node_modules/@deepseek-ai/{dsh-llm,dsh-llm-deepseek,dsh-agent,dsh-agent-presets,dsh-skill,
  dsh-skill-filesystem,dsh-tool-skill,dsh-tools,dsh-tool-goal,dsh-subagent,dsh-workflow}/lib`.
- `node_modules/@agentclientprotocol/sdk@0.25.1` `dist/schema/types.gen.d.ts` + `dist/acp.d.ts`.
- ACP spec repo `schema/v1/schema.json`; live docs `agentclientprotocol.com/protocol/{session-modes,
  session-config-options,slash-commands}`; Zed source `crates/agent_ui/src/{config_options,
  mode_selector,conversation_view,message_editor}.rs`, `crates/acp_thread/src/connection.rs`,
  `crates/agent_servers/src/acp.rs`.
- This repo: `docs/DSH-extension-facts.md`, `docs/zed-acp-integration-fact-sheet.md`,
  `cordis.yml`, `src/index.ts`, `src/bridge.ts`.
