/**
 * DSHACP bridge: a widened Agent Client Protocol v1 server over JSON-RPC stdio.
 *
 * Where `@deepseek-ai/dsh-acp` is deliberately automation-only (committed text,
 * no sessions list), this bridge exposes DSH's full core loop to an interactive
 * ACP client such as Zed: token-level streaming, reasoning, tool calls with
 * inputs/outputs, plans, usage, approval pushed to the client, and complete
 * session management (new/load/resume/list/delete/close/cancel).
 *
 * @module dshacp/bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent as AcpAgent,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type CreateElicitationResponse,
  type DeleteSessionRequest,
  type ElicitationSchema,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type PlanEntryStatus,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionConfigSelectOptions,
  type SessionInfo,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type StopReason,
  type Stream,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk'
import { installModelSelection, type Agent, type AgentSetup, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset, type AgentPreset, type AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId, type Session, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
// Side-effect type imports: declaration-merge the event maps answered below.
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-workflow'
// Declaration-merge the `agent-preset/selected` session event (P4b mode switch).
import type {} from '@deepseek-ai/dsh-agent-presets'
import { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import {
  acpPromptToText,
  encodeModelOption,
  imageExtensionForMime,
  parseModelOption,
  parseToolArguments,
  promptHasUnsupportedContent,
  todoToPlanEntries,
  toolKindForName,
  toolResultToText,
  turnEndToStopReason,
} from './codec.ts'

export const name = 'dshacp-bridge'
/** The bridge creates and owns agents; the title service and store serve the wire. */
export const inject = ['agents', 'sessionTitle', 'sessions', 'userQuestions', 'llm']

/** Default permission-request timeout: fail-closed after this long (DESIGN §7). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

/** Default user-question (elicitation) timeout: fail-closed after this long (DESIGN P4b). */
export const DEFAULT_ELICITATION_TIMEOUT_MS = 30 * 60 * 1000

/** ACP config-option ids for model / thinking / mode (DESIGN §12.4). */
export const MODEL_OPTION_ID = 'model'
export const THINKING_OPTION_ID = 'thought_level'
export const MODE_OPTION_ID = 'mode'

/** Composition-default route, matching the base agent-default-model row. */
export const DEFAULT_PROVIDER = 'deepseek-official'
export const DEFAULT_MODEL = 'deepseek-v4-flash'

/** Per-tool-call timeout for forwarded MCP servers (the mcp-client default). */
export const DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS = 60_000

/**
 * Max bytes accepted for one pasted image before the prompt is rejected (P5).
 * Pasting is capped at 25 MB per image; larger payloads are refused with a
 * clear error instead of being written to tmp.
 */
export const MAX_PASTED_IMAGE_BYTES = 25 * 1024 * 1024

/**
 * Fixed plan-entry priority for every mapped update (DESIGN §17): DSH todos
 * carry no priority, so the mapping pins `medium` for todo, workflow, and
 * subagent plans alike.
 */
export const PLAN_PRIORITY = 'medium' as const

/**
 * The single continuable-subagent teardown the bridge needs. Declared
 * structurally so this package does not depend on the subagent seam for one
 * shutdown hook; an absent service means nothing continuable was materialized.
 */
interface ContinuableDrain {
  drainContinuableDescendants(parents: readonly Agent[]): Promise<void>
}

/** Preserve invalid-parameter detail in the SDK wire error message. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/** Plugin config: provider/model selection, approval and elicitation timeouts. */
export interface BridgeConfig {
  /** Provider route seeding created agents; absent reuses the composition default. */
  provider?: string
  /** Model name seeding created agents; absent reuses the composition default. */
  model?: string
  /** How long a pushed permission request waits for the client before rejecting (fail-closed). */
  approvalTimeoutMs?: number
  /** How long an elicitation (`ask_user_question`) waits for the user before failing closed. */
  elicitationTimeoutMs?: number
  /**
   * P3 hybrid mode: when true AND the client advertised
   * `clientCapabilities.fs.writeTextFile`, the `write` tool is shadowed by a
   * per-agent tool that delegates to the client's `fs/write_text_file`, so Zed
   * applies the edit and offers per-hunk diff review. Everything else stays
   * DSH-owned. Default false (opt-in).
   */
  hybridFileWrites?: boolean
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
}

export const Config: Schema<BridgeConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  approvalTimeoutMs: Schema.natural().default(DEFAULT_APPROVAL_TIMEOUT_MS),
  elicitationTimeoutMs: Schema.natural().default(DEFAULT_ELICITATION_TIMEOUT_MS),
  hybridFileWrites: Schema.boolean().default(false),
})

/** Per-session protocol state. */
interface SessionRecord {
  agent: Agent
  /** Exact owned-agent disposer; resolves after registry, loop, and session teardown. */
  dispose: () => Promise<void>
  /** In-flight prompt and its captured turn number for exact settlement. */
  inflight: {
    resolve: (reason: StopReason) => void
    reject: (error: Error) => void
    messageId: string
    turn: number | undefined
    /** The correlated turn's ending, set at turn/end and settled at whole-agent idle. */
    endReason: TurnEndReason | undefined
  } | undefined
  /** Pushed permission request awaiting the client; answered `cancelled` on cancel/close. */
  permission: {
    settle: (outcome: ApprovalOutcome) => void
    timer: ReturnType<typeof setTimeout>
  } | undefined
  /** Tool names the user granted `allow_always`; their calls skip the push. */
  allowedTools: Set<string>
  /** Live workflow run being rendered as plan updates (P2-1). */
  workflow: {
    runId: string
    name: string
    phase: string | undefined
    agents: Map<number, { label: string; phase?: string; status: PlanEntryStatus }>
  } | undefined
  /** Per-session model selection (P4b): mutated by the `model`/`thought_level` config options. */
  selection: ModelSelectionRef | undefined
  /** The preset id this session runs (P4b): set at setup, updated by mode switches. */
  preset: string | undefined
  /** Cumulative token accounting for `usage_update` (session-wide). */
  usage: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning: number
  }
}

/**
 * Mount the DSHACP bridge.
 * @param ctx - Cordis context carrying the agent factory and session events.
 * @param config - Provider/model selection, approval timeout, and optional test transport.
 */
export function apply(ctx: Context, config: BridgeConfig): void {
  // ACP handlers execute outside this plugin's injection scope, so capture the
  // injected services during apply rather than reading them lazily in a callback.
  const agents = ctx.agents
  const logger = ctx.logger
  const userQuestions = ctx.userQuestions
  const sessions = new Map<SessionId, SessionRecord>()
  const approvalTimeoutMs = config.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  const elicitationTimeoutMs = config.elicitationTimeoutMs ?? DEFAULT_ELICITATION_TIMEOUT_MS
  let closed = false
  /** Whether the client advertised `fs.writeTextFile` at initialize (P3 gate). */
  let clientFsWrite = false
  /** Whether the client advertised form elicitation at initialize (P4b gate). */
  let clientElicitation = false
  /** Zed-forwarded MCP servers mounted once per raw server name (P4b), disposed at quiesce. */
  const mountedMcp = new Map<string, Promise<{ dispose: () => Promise<void> } | undefined>>()
  let conn: AgentSideConnection

  /**
   * The default-model service (base `agent-default-model` row), read
   * structurally. `saveSelection` persists the chosen provider/model/effort
   * into the user's settings document — the same write the web Models page
   * makes — so the next fresh session starts from the last chosen combination.
   */
  interface DefaultModelService {
    currentSelection(): ModelSelection
    saveSelection(next: ModelSelection): Promise<void>
  }
  const defaultModelService = (): DefaultModelService | undefined =>
    ctx.get('agentDefaultModel') as DefaultModelService | undefined

  /**
   * Persist the session's chosen model/thinking combination as the deployment
   * default (DESIGN D14 extension: "remember the last combination"). Best
   * effort — a settings write failure never fails the option switch.
   */
  const persistSelection = (record: SessionRecord): void => {
    const selected = selectionFor(record).current
    const defaults = defaultModelService()
    if (selected === undefined || defaults === undefined) return
    defaults.saveSelection(selected).catch((error: unknown) => {
      logger.warn(`dshacp: the model selection applies to this session but was not saved as the default: ${String(error)}`)
    })
  }

  /** The agent-presets roster (base/preset composition), read structurally. */
  const presetRoster = (): AgentPresets | undefined => ctx.get('agentPresets') as AgentPresets | undefined

  /**
   * The mutable per-session model selection (DESIGN D8/D14). A picked value
   * wins; otherwise the session's own `request/header` restores the last
   * model/effort (resume), and the deployment default (agent-default-model)
   * is the fallback. Installed on the agent once at creation; the
   * `model`/`thought_level` config options mutate it.
   */
  const selectionFor = (record: SessionRecord): ModelSelectionRef => {
    const installed = record.selection
    if (installed !== undefined) return installed
    let picked: ModelSelection | undefined
    if (config.provider !== undefined || config.model !== undefined) {
      picked = {
        provider: config.provider ?? DEFAULT_PROVIDER,
        model: config.model ?? DEFAULT_MODEL,
      }
    }
    const selection: ModelSelectionRef = {
      get current() {
        if (picked !== undefined) return picked
        const logged = record.agent.session.requestHeader()?.config
        if (logged !== undefined) {
          return {
            provider: logged.provider,
            model: logged.model,
            ...(logged.reasoningEffort !== undefined ? { reasoningEffort: logged.reasoningEffort } : {}),
          }
        }
        const defaults = defaultModelService()
        if (defaults !== undefined) {
          const current = defaults.currentSelection()
          if (current !== undefined) return current
        }
        return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }
      },
      set current(next) {
        picked = next
        // Keep the agent's options in lockstep so children spawned after a
        // dynamic model switch still inherit the parent's current route.
        syncAgentRoute(record)
      },
      assembled: undefined,
    }
    record.selection = selection
    return selection
  }

  /**
   * Mirror the resolved model route onto the live agent's options
   * (subagent-fix Plan A). Delegation tools inherit provider/model from the
   * parent's `AgentOptions`, so the pair must track the parent's actual
   * selection — the config/defaults route for fresh sessions, the persisted
   * request header restored on resume, and later `model` option switches.
   * `Agent.options` is typed readonly, but the loop stores the creation
   * object by reference and reads it at use time (request seed, prompt
   * variables, child inheritance), so this write-through is effective and
   * never changes the parent's own routing (`installModelSelection` already
   * overrides that surface).
   */
  const syncAgentRoute = (record: SessionRecord): void => {
    const selected = selectionFor(record).current
    if (selected === undefined) return
    const options = record.agent.options as { provider?: string; model?: string }
    try {
      options.provider = selected.provider
      options.model = selected.model
    } catch (error: unknown) {
      // Best-effort refinement: the create-time route from `agentOptions()`
      // already guarantees children a concrete model, so a loop that ever
      // freezes options must degrade to a warning, not fail adoption.
      logger.warn(`dshacp: could not sync the model route into the agent options: ${String(error)}`)
    }
  }

  /** Whether a session has produced nothing — the only state a mode switch may mutate (D9). */
  const sessionBlank = (session: Session): boolean =>
    !session.events.some(event => event.type === 'turn/start')

  /**
   * Return the bridge-owned record for an agent, rejecting same-id impostors.
   */
  const ownedRecord = (agent: Agent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }

  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId: SessionId): SessionRecord => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** Send a protocol update without letting a disconnected client fail an agent turn. */
  const notify = (notification: SessionNotification): void => {
    /* v8 ignore next 3 -- only a transport write failure reaches this guard. */
    void conn.sessionUpdate(notification).catch((error: unknown) => {
      logger.warn(`dshacp: session/update failed: ${String(error)}`)
    })
  }

  const settlePrompt = (record: SessionRecord, reason: StopReason): void => {
    const inflight = record.inflight
    if (inflight === undefined) return
    record.inflight = undefined
    inflight.resolve(reason)
  }

  const settlePermission = (record: SessionRecord, outcome: ApprovalOutcome): void => {
    const permission = record.permission
    if (permission === undefined) return
    record.permission = undefined
    clearTimeout(permission.timer)
    permission.settle(outcome)
  }

  // ── P4b: config options (model / thinking / mode) ─────────────────────────

  /**
   * Spread one optional field into an object literal only when defined. The
   * literal form `...(x !== undefined ? { k: x } : {})` recurs across the
   * option builders; this keeps the mapping one token per field while the
   * result type stays `Pick` (unlike `pickDefined`, which spreads the whole
   * partial source type).
   */
  const withDefined = <T, K extends keyof T>(source: T, key: K): Pick<T, K> =>
    source[key] !== undefined ? { [key]: source[key] } as Pick<T, K> : {} as Pick<T, K>

  /** One catalog model entry: model id/name plus optional reasoning metadata. */
  interface CatalogModel {
    id: string
    name: string
    description?: string
    reasoning?: {
      efforts: { id: string; name: string; description?: string }[]
      defaultEffort?: string
    }
  }
  /** One provider group of the model catalog. */
  interface CatalogGroup {
    id: string
    name: string
    models: CatalogModel[]
  }

  /**
   * The dynamic model catalog: every registered provider's models with their
   * reasoning metadata resolved per model (DESIGN D6). A provider that fails
   * to answer contributes no group; the option surface never fails the wire.
   */
  const buildModelCatalog = async (): Promise<CatalogGroup[]> => {
    const llm = ctx.llm
    if (llm === undefined) return []
    const groups = await Promise.all(llm.listProviders().map(async (provider) => {
      try {
        const models = await llm.listModels(provider.id)
        const entries = await Promise.all(models.map(async (model): Promise<CatalogModel> => {
          const resolved = await llm.resolveModelInfo(provider.id, model.id)
          return {
            id: model.id,
            name: model.name,
            ...withDefined(model, 'description'),
            ...(resolved.reasoning !== undefined ? {
              reasoning: {
                efforts: resolved.reasoning.efforts.map(effort => ({
                  id: effort.id,
                  name: effort.name,
                  ...withDefined(effort, 'description'),
                })),
                ...withDefined(resolved.reasoning, 'defaultEffort'),
              },
            } : {}),
          }
        }))
        return { id: provider.id, name: provider.name, models: entries }
      } catch (error: unknown) {
        logger.warn(`dshacp: model catalog for provider "${provider.id}" failed: ${String(error)}`)
        return { id: provider.id, name: provider.name, models: [] }
      }
    }))
    return groups.filter(group => group.models.length > 0)
  }

  /**
   * The complete configOptions list for one session (DESIGN §12.4, D3/D7).
   * @param record - the session whose options to render.
   * @param groups - a caller-provided model catalog (the apply path builds one
   *   catalog for both the mutation and the response); built here when absent.
   */
  const buildConfigOptions = async (
    record: SessionRecord,
    groups?: CatalogGroup[],
  ): Promise<SessionConfigOption[]> => {
    const catalog = groups ?? await buildModelCatalog()
    const selection = selectionFor(record).current ?? { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL }
    const options: SessionConfigOption[] = []
    // Model select: flat when one provider route, grouped otherwise. Values
    // are `provider:model` — model ids are not unique across providers, and
    // the current value must highlight exactly one option.
    let modelOptions: SessionConfigSelectOptions = []
    if (catalog.length > 1) {
      modelOptions = catalog.map(group => ({
        group: group.id,
        name: group.name,
        options: group.models.map(model => ({
          name: model.name,
          value: encodeModelOption(group.id, model.id),
          ...withDefined(model, 'description'),
        })),
      }))
    } else if (catalog[0] !== undefined) {
      const single = catalog[0]
      modelOptions = single.models.map(model => ({
        name: model.name,
        value: encodeModelOption(single.id, model.id),
        ...withDefined(model, 'description'),
      }))
    }
    options.push({
      id: MODEL_OPTION_ID,
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: encodeModelOption(selection.provider, selection.model),
      options: modelOptions,
    })
    // Thinking select: only when the current model exposes reasoning efforts.
    // Resolve the current model within its own provider group — the same id
    // may exist on several providers with different efforts.
    const currentInfo = catalog
      .find(group => group.id === selection.provider)
      ?.models.find(model => model.id === selection.model)
    const efforts = currentInfo?.reasoning?.efforts ?? []
    if (efforts.length > 0) {
      const currentEffort = selection.reasoningEffort
        ?? currentInfo?.reasoning?.defaultEffort
        ?? efforts[0]!.id
      options.push({
        id: THINKING_OPTION_ID,
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: currentEffort,
        options: efforts.map(effort => ({
          name: effort.name,
          value: effort.id,
          ...withDefined(effort, 'description'),
        })),
      })
    }
    // Mode select: the preset roster (DESIGN D3/D9).
    const presets = presetRoster()
    if (presets !== undefined) {
      const roster = await presets.list()
      options.push({
        id: MODE_OPTION_ID,
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: record.preset ?? presets.defaultId,
        options: roster
          .filter(preset => preset.broken === undefined)
          .map(preset => ({
            name: preset.name ?? preset.id,
            value: preset.id,
            ...withDefined(preset, 'description'),
          })),
      })
    }
    return options
  }

  /**
   * Apply one `session/set_config_option` (DESIGN §12.4.3). Model and thinking
   * validate through the llm runtime before mutating the selection; a model
   * switch resets thinking to the model's default effort (D8). A mode switch
   * recomposes only a blank session; a started session soft-rejects (returns
   * the unchanged list and logs) because its tool set is fixed by the log.
   * @returns the model catalog the apply path built (the model branch), so
   *   the response can reuse it instead of re-resolving every model.
   */
  const applyConfigOption = async (
    record: SessionRecord,
    params: SetSessionConfigOptionRequest,
  ): Promise<CatalogGroup[] | undefined> => {
    if ('type' in params) {
      throw invalidParams(`config option "${params.configId}" is a select, not a boolean`)
    }
    const selection = selectionFor(record)
    if (params.configId === MODEL_OPTION_ID) {
      const groups = await buildModelCatalog()
      // Resolve the provider for the requested value: a `provider:model` pair
      // (the option values we emit) or a bare model id (a legacy
      // `default_config_options` entry). A bare id that exists on exactly one
      // provider picks it; one that exists on several keeps the current
      // provider when it owns the model, otherwise the ambiguity is rejected.
      const parsed = parseModelOption(params.value)
      const modelId = parsed?.model ?? params.value
      const owningProviders = groups
        .filter(group => group.models.some(model => model.id === modelId))
        .map(group => group.id)
      let provider: string
      if (parsed !== undefined) {
        if (!owningProviders.includes(parsed.provider)) throw invalidParams(`unknown model: ${params.value}`)
        provider = parsed.provider
      } else if (owningProviders.length === 1) {
        provider = owningProviders[0]!
      } else if (owningProviders.length > 1) {
        const current = selection.current
        if (current !== undefined && owningProviders.includes(current.provider)) {
          provider = current.provider
        } else {
          throw invalidParams(
            `model "${params.value}" exists on multiple providers (${owningProviders.join(', ')}); select it with provider:model`,
          )
        }
      } else {
        throw invalidParams(`unknown model: ${params.value}`)
      }
      let info: { reasoning?: { defaultEffort?: string; efforts: readonly { id: string }[] } }
      try {
        // Validate through the llm runtime exactly like the web app's model
        // picker (DESIGN §12.4.3), then read the target model's metadata.
        await ctx.llm.resolveCallConfig({ provider, model: modelId })
        info = await ctx.llm.resolveModelInfo(provider, modelId)
      } catch (error: unknown) {
        throw invalidParams(`unknown model: ${params.value} (${String(error)})`)
      }
      // D8: switching model resets thinking to that model's default effort.
      // Without an adapter default, pin the first offered effort so the
      // stored selection and the displayed option agree.
      const defaultEffort = info.reasoning?.defaultEffort ?? info.reasoning?.efforts[0]?.id
      selection.current = {
        provider,
        model: modelId,
        ...(defaultEffort !== undefined ? { reasoningEffort: ReasoningEffortId(defaultEffort) } : {}),
      }
      persistSelection(record)
      return groups
    } else if (params.configId === THINKING_OPTION_ID) {
      const current = selection.current
      if (current === undefined) throw invalidParams('no model is selected for this session')
      try {
        await ctx.llm.resolveCallConfig({
          provider: current.provider,
          model: current.model,
          reasoningEffort: ReasoningEffortId(params.value),
        })
      } catch (error: unknown) {
        throw invalidParams(`unsupported reasoning effort for ${current.model}: ${params.value} (${String(error)})`)
      }
      selection.current = {
        provider: current.provider,
        model: current.model,
        reasoningEffort: ReasoningEffortId(params.value),
      }
      persistSelection(record)
    } else if (params.configId === MODE_OPTION_ID) {
      const presets = presetRoster()
      if (presets === undefined) throw invalidParams('this deployment composes no agent presets')
      if (!sessionBlank(sessionOf(record))) {
        // DESIGN D9: the mode is fixed once a session has started — return the
        // old value and log; no exception (Zed's dropdown snaps back).
        logger.warn(`dshacp: mode switch to "${params.value}" refused: session ${params.sessionId} has already started`)
        return
      }
      try {
        const preset: AgentPreset = await presets.recompose(record.agent.ctx, params.value)
        sessionOf(record).append('agent-preset/selected', { agentPreset: preset.id })
        record.preset = preset.id
        // Presets differ in which skill tooling they mount; refresh the
        // `/`-menu catalog for the new composition.
        void pushAvailableCommands(record)
      } catch (error: unknown) {
        throw invalidParams(`cannot switch mode: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      throw invalidParams(`unknown config option: ${params.configId}`)
    }
  }

  // ── P4b: slash commands over userInvocable skills ─────────────────────────

  /**
   * Push the `/`-menu catalog: every `userInvocable` skill of this session's
   * scope (DESIGN D10). Invocation itself needs no bridge code — the preset's
   * `tool-skill` pre-step hook already injects `renderSkillContent` for
   * `/name` gestures in user messages.
   */
  const pushAvailableCommands = async (record: SessionRecord): Promise<void> => {
    const skills = ctx.get('skills')
    if (skills === undefined) return
    try {
      const session = sessionOf(record)
      const summaries = await skills.list({ cwd: session.header.cwd, scope: record.agent })
      const availableCommands = summaries
        .filter(isUserInvocable)
        .map(summary => ({ name: summary.name, description: summary.description }))
      notify({
        sessionId: session.id,
        update: { sessionUpdate: 'available_commands_update', availableCommands },
      })
    } catch (error: unknown) {
      logger.warn(`dshacp: available commands update failed: ${String(error)}`)
    }
  }

  // ── P4b: MCP forwarding (session/new mcpServers → dsh-mcp-client) ─────────

  /** Sanitize a forwarded server name into the `[A-Za-z0-9_-]{1,32}` namespace. */
  const sanitizeServerName = (name: string): string => {
    const base = name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32)
    return base.length > 0 ? base : 'mcp'
  }

  /**
   * Mount Zed-forwarded MCP servers as `dsh-mcp-client` plugin instances
   * (DESIGN D12). Servers are keyed by their raw wire name and mounted once
   * process-wide — DSH's MCP model is composition-global — so a later session
   * forwarding the same server reuses the live instance. Stdio is the spec's
   * mandatory transport; http maps to `streamable-http`; sse and acp are
   * unsupported and skipped with a diagnostic. A failed mount never fails the
   * session.
   */
  const forwardMcpServers = async (servers: readonly McpServer[] | undefined): Promise<void> => {
    if (servers === undefined || servers.length === 0) return
    for (const server of servers) {
      if ('type' in server && (server.type === 'sse' || server.type === 'acp')) {
        logger.warn(`dshacp: mcp server "${server.name}" uses the ${server.type} transport, which is not supported; skipped`)
        continue
      }
      if (mountedMcp.has(server.name)) {
        logger.info(`dshacp: mcp server "${server.name}" is already forwarded; reusing its tools`)
        continue
      }
      const serverName = sanitizeServerName(server.name)
      const config = 'type' in server
        ? {
            transport: 'streamable-http' as const,
            serverName,
            url: server.url,
            headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])),
            toolCallTimeoutMs: DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
            failOnStartupError: false,
          }
        : {
            transport: 'stdio' as const,
            serverName,
            command: server.command,
            args: server.args,
            env: Object.fromEntries(server.env.map(entry => [entry.name, entry.value])),
            // The child inherits the process cwd (the project root Zed launches from).
            cwd: process.cwd(),
            toolCallTimeoutMs: DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
            failOnStartupError: false,
          }
      const mount = (async () => {
        try {
          const plugin = await ctx.plugin(mcpClient, config)
          return plugin as unknown as { dispose: () => Promise<void> }
        } catch (error: unknown) {
          logger.warn(`dshacp: forwarding mcp server "${server.name}" failed: ${String(error)}`)
          mountedMcp.delete(server.name)
          return undefined
        }
      })()
      mountedMcp.set(server.name, mount)
      await mount
    }
  }

  // ── P4b: elicitation (ask_user_question → session/request_elicitation) ────

  /**
   * Race an elicitation against the owning tool call's abort signal and the
   * fail-closed timeout, so a cancelled turn or a silent user never leaves
   * the agent loop hanging.
   */
  const raceElicitation = (
    promise: Promise<CreateElicitationResponse>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<CreateElicitationResponse> => new Promise((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new UserQuestionError('the question was aborted', 'ABORTED'))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new UserQuestionError('the user did not answer in time', 'TIMEOUT'))
    }, timeoutMs)
    timer.unref?.()
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    promise.then(
      (result) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })

  /**
   * The DSH user-questions provider backed by ACP elicitation: the tool
   * pauses until Zed renders a form from the question schema and the user
   * answers (DESIGN D13, P4b-4). Decline/cancel/timeout fail the tool call
   * closed through the ordinary result pipeline.
   */
  const askViaElicitation = async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
    const record = request.agent !== undefined ? ownedRecord(request.agent) : undefined
    if (record === undefined) {
      throw new UserQuestionError('the asking agent is not a live DSHACP session', 'CALLER_NOT_LIVE')
    }
    if (conn === undefined) {
      throw new UserQuestionError('the ACP connection is not ready', 'CONNECTION_NOT_READY')
    }
    if (!clientElicitation) {
      throw new UserQuestionError('the ACP client does not advertise elicitation; ask_user_question is unavailable', 'CLIENT_UNSUPPORTED')
    }
    const properties: ElicitationSchema['properties'] = {}
    const required: string[] = []
    for (const [index, question] of request.questions.entries()) {
      const key = `q${index}`
      const description = question.detail !== undefined
        ? `${question.question}\n\n${question.detail}`
        : question.question
      const labels = question.options?.map(option => option.label) ?? []
      if (question.multiSelect === true) {
        properties[key] = { type: 'array', description, items: { type: 'string', enum: labels } }
      } else if (labels.length > 0) {
        properties[key] = { type: 'string', description, enum: labels }
      } else {
        properties[key] = { type: 'string', description }
      }
      required.push(key)
    }
    const message = request.questions.map(question => question.question).join(' ')
    const response = await raceElicitation(
      conn.unstable_createElicitation!({
        mode: 'form',
        message,
        sessionId: sessionOf(record).id,
        requestedSchema: { type: 'object', properties, required },
      }),
      request.signal,
      elicitationTimeoutMs,
    )
    if (response.action !== 'accept') {
      throw new UserQuestionError(
        response.action === 'cancel'
          ? 'the user cancelled the question'
          : 'the user declined the question',
        'USER_DECLINED',
      )
    }
    const answers = request.questions.map((question, index) => {
      const value = response.content?.[`q${index}`]
      const selected = Array.isArray(value)
        ? value.map(String)
        : value !== undefined && value !== null
          ? [String(value)]
          : []
      return { id: question.id, selected }
    })
    return { answers }
  }

  // The single UI provider slot belongs to this bridge for the whole process.
  userQuestions.registerProvider({ ask: askViaElicitation })

  /** Accumulate one call's token accounting and report the session-wide total. */
  const accumulateUsage = (
    record: SessionRecord,
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number },
  ): void => {
    record.usage.input += usage.inputTokens
    record.usage.output += usage.outputTokens
    record.usage.cacheRead += usage.cacheReadTokens ?? 0
    record.usage.cacheWrite += usage.cacheWriteTokens ?? 0
    record.usage.reasoning += usage.reasoningTokens ?? 0
    // "Tokens currently in context": input + cache-read + non-reasoning output.
    // reasoningTokens is a subset of outputTokens (DeepSeek's completion_tokens
    // already includes reasoning), and reasoning_content does NOT participate in
    // the next turn's context (DeepSeek Thinking Mode), so it is subtracted out
    // of output rather than merely "not double-counted". cacheWriteTokens is
    // input-side cache-write traffic (not a DeepSeek wire field), also excluded.
    // This matches the token-meter context-occupancy/compaction convention:
    // reasoning never contributes to context occupancy.
    const used = record.usage.input + record.usage.cacheRead
      + Math.max(0, record.usage.output - record.usage.reasoning)
    if (used <= 0) return
    const size = sessionOf(record).requestContext()?.contextWindow ?? 0
    notify({
      sessionId: sessionOf(record).id,
      update: { sessionUpdate: 'usage_update', used, size },
    })
  }

  /**
   * Emit the wire notifications for one durable session event. Shared by the
   * live `session/event` listener and by `session/load` history replay, so the
   * client sees identical rendering for live and replayed turns. User messages
   * are echoed only on replay: an interactive client renders its own copy of
   * the user's prompt, and only direct human prompts (`source.kind: 'user'`)
   * are replayed — injected context stays off the wire.
   */
  const emitForEvent = (record: SessionRecord, event: SessionEvent, replay = false): void => {
    const sessionId = sessionOf(record).id
    switch (event.type) {
      case 'user/message': {
        if (!replay || event.data.source.kind !== 'user') return
        for (const block of event.data.content) {
          if (block.type === 'text' && block.text.length > 0) {
            notify({
              sessionId,
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: block.text },
                messageId: `usr-${event.seq}`,
              },
            })
          }
        }
        return
      }
      case 'assistant/chunk': {
        const { turn, step, chunk } = event.data
        const messageId = `msg-${turn}-${step}`
        if (chunk.type === 'text-delta' && chunk.text.length > 0) {
          notify({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: chunk.text },
              messageId,
            },
          })
        } else if (chunk.type === 'reasoning-delta' && chunk.text.length > 0) {
          notify({
            sessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: chunk.text },
              messageId: `thought-${turn}-${step}`,
            },
          })
        }
        return
      }
      case 'assistant/message': {
        if (event.data.usage !== undefined) accumulateUsage(record, event.data.usage)
        return
      }
      case 'tool/call': {
        const { callId, name, arguments: raw } = event.data
        notify({
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: callId,
            title: name,
            kind: toolKindForName(name),
            status: 'pending',
            rawInput: parseToolArguments(raw),
          },
        })
        return
      }
      case 'tool/result': {
        const { message, error } = event.data
        const toolCallId = message.content[0]?.toolCallId
        if (toolCallId === undefined) return
        notify({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: error !== undefined ? 'failed' : 'completed',
            rawOutput: toolResultToText(message.content, error),
          },
        })
        return
      }
      case 'todo/write': {
        notify({
          sessionId,
          update: { sessionUpdate: 'plan', entries: todoToPlanEntries(event.data.todos) },
        })
        return
      }
      case 'session/title': {
        notify({
          sessionId,
          update: { sessionUpdate: 'session_info_update', title: event.data.title },
        })
        return
      }
      default:
        return
    }
  }

  ctx.on('session/event', (session, event: SessionEvent) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || sessionOf(record) !== session) return
    try {
      emitForEvent(record, event)
    } finally {
      const inflight = record.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        if (event.data.reason.kind === 'error') {
          // Model failures surface immediately as prompt errors; ordinary
          // endings wait for whole-agent idle below.
          record.inflight = undefined
          inflight.reject(internalError(`turn failed: ${event.data.reason.error.message}`))
        } else {
          inflight.endReason = event.data.reason
        }
      }
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (inflight !== undefined && inflight.messageId === message.id) inflight.turn = turn
  })

  // The `/`-menu catalog tracks the skill catalog: an authoring change (a
  // skill created or removed) refreshes every live session's commands.
  ctx.on('skills/change', () => {
    for (const record of sessions.values()) void pushAvailableCommands(record)
  })

  ctx.on('agent/error', ({ agent, turn, error }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    // A correlated turn error is already rejected by the `turn/end` error
    // branch in the session/event handler (durable turn/end always follows);
    // this listener catches errors outside that correlation — a prompt whose
    // inbox claim never arrived, or an agent that errored before its turn —
    // so the prompt fails rather than settling as `cancelled` at quiescence.
    if (record === undefined || inflight === undefined || inflight.turn === turn) return
    record.inflight = undefined
    inflight.reject(internalError(`turn failed: ${errorChain(error)}`))
  })

  // Permission requests are pushed to the client (DESIGN §7 + P2-3): hold the
  // synchronous waterfall, ask over ACP, backfill the outcome, and fail closed
  // on timeout or disconnect. `allow_always` grants one call now and records
  // the tool name in the session's allowlist so later calls of that tool skip
  // the push entirely (per-session, per-tool semantics; the DSH approval
  // policy itself stays `ask`). A grant is never inferred from an unknown
  // client response.
  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    const callId = request.callId
    if (record === undefined || callId === undefined) return next()
    if (closed) return Promise.resolve('rejected')
    if (record.allowedTools.has(request.toolName)) return Promise.resolve('allowed-once')
    return new Promise<ApprovalOutcome>((resolve) => {
      const settle = (outcome: ApprovalOutcome): void => {
        // Every path — client answer, timeout, or cancel — clears the pending
        // slot so a later cancel cannot settle a stale permission.
        if (record.permission?.settle === settle) record.permission = undefined
        clearTimeout(timer)
        resolve(outcome)
      }
      const timer = setTimeout(() => settle('rejected'), approvalTimeoutMs)
      timer.unref?.()
      record.permission = { settle, timer }
      const toolCall: ToolCallUpdate = {
        toolCallId: String(callId),
        title: request.toolName,
        kind: toolKindForName(request.toolName),
        status: 'pending',
      }
      void conn.requestPermission({
        sessionId: sessionOf(record).id,
        toolCall,
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
      }).then(({ outcome }) => {
        if (outcome.outcome === 'cancelled') settle('cancelled')
        else if (outcome.optionId === 'allow_once') settle('allowed-once')
        else if (outcome.optionId === 'allow_always') {
          record.allowedTools.add(request.toolName)
          settle('allowed-once')
        } else settle('rejected')
      }).catch(() => settle('rejected'))
    })
  })

  /** Reject same-session features outside the supported surface (P1). */
  const validateSessionParams = (params: NewSessionRequest): void => {
    if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    // `mcpServers` is a required v1 param; P4b forwards it into dsh-mcp-client.
    if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
      logger.info('dshacp: additionalDirectories is accepted but not applied')
    }
  }

  /**
   * Per-agent setup (DESIGN §12.4.2): compose the agent from the preset the
   * session runs and, in P3 hybrid mode, shadow the global `write` tool with
   * a per-agent tool delegating to the client's `fs/write_text_file` when the
   * client advertised `clientCapabilities.fs.writeTextFile`. Zed applies the
   * edit to its buffers and offers per-hunk diff review; everything else
   * stays DSH-owned. Relative paths resolve against the session cwd (the ACP
   * wire requires absolute paths).
   *
   * The preset id resolves from the session itself: the creation header names
   * it for fresh sessions (`agentPreset` in `meta`), and a loaded log's last
   * `agent-preset/selected` event wins for resume (DESIGN D14).
   */
  const composeSetup = (sessionId: SessionId, cwd: string): AgentSetup => async (agentCtx) => {
    if (config.hybridFileWrites === true && clientFsWrite) {
      agentCtx.tools.register(defineTool({
        name: 'write',
        description: 'Create or fully replace a UTF-8 text file. The file is written by the client editor (hybrid mode), so the change appears as a reviewable diff.',
        parameters: {
          file_path: {
            type: 'string',
            required: true,
            description: 'Absolute path, or path relative to the working directory, to write.',
          },
          content: {
            type: 'string',
            required: true,
            description: 'Full UTF-8 text content to write.',
          },
          // Schema parity with the global write tool: the sandbox escalation
          // fields are accepted and ignored — hybrid writes go through the
          // client editor, which is not sandboxed by this process.
          sandbox_permissions: {
            type: 'string',
            description: 'Accepted for schema parity; ignored in hybrid mode.',
          },
          justification: {
            type: 'string',
            description: 'Accepted for schema parity; ignored in hybrid mode.',
          },
        },
        output: {
          // Mirrors the global write tool's result shape (path/operation/
          // before/after) so the model sees a consistent vocabulary.
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              operation: { type: 'string', required: true },
              before: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              after: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: `The file ${value.path} has been written via the client editor (hybrid mode).`,
          }],
        },
        async execute(args) {
          const target = isAbsolute(args.file_path) ? args.file_path : join(cwd, args.file_path)
          // The connection is assigned before any session handler can run
          // (makeAgent completes inside initialize); guard anyway so a
          // misordered client call fails loudly instead of throwing a null
          // dereference.
          if (conn === undefined) throw new Error('client write failed (hybrid mode): connection not ready')
          try {
            await conn.writeTextFile({ sessionId, path: target, content: args.content })
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            throw new Error(`client write failed (hybrid mode): ${detail}`)
          }
          // The client owns the edit; report the full intended content as the
          // after-state (before is unknown to this process).
          return { path: target, operation: 'client-write', before: null, after: args.content }
        },
      }))
    }
    // Compose the agent from the preset the session runs. The roster mount is
    // the one supported call site: while the agent is still unpublished, a
    // rejected composition rolls the whole creation back.
    const presets = presetRoster()
    const agent = agentCtx.agent
    if (presets !== undefined) {
      const presetId = agent !== undefined
        ? resolveSessionPreset(agent.session) ?? presets.defaultId
        : presets.defaultId
      if (presetId !== undefined) await presets.mount(agentCtx, presetId)
    }
  }

  /**
   * Resolve the bridge session a delegated run (workflow/subagent) belongs to
   * (P2-1). These events carry no agent identity, but a run only executes
   * while the initiating agent's tool call is in flight. The initiator
   * boundary is the precise correlation when the event chain still carries
   * it; otherwise the pending-turn record is the owner — and only when it is
   * UNIQUE, so concurrent sessions can never misattribute a plan update.
   */
  const turnOwner = (): SessionRecord | undefined => {
    const initiator = agents.currentInitiator()
    if (initiator !== undefined) {
      const record = ownedRecord(initiator)
      if (record !== undefined) return record
    }
    const pending = [...sessions.values()].filter(record => record.inflight !== undefined)
    return pending.length === 1 ? pending[0] : undefined
  }

  /** Send the workflow state as a whole-plan replacement (DESIGN P2-1). */
  const emitWorkflowPlan = (record: SessionRecord): void => {
    const workflow = record.workflow
    if (workflow === undefined) return
    const entries: { content: string; priority: typeof PLAN_PRIORITY; status: PlanEntryStatus }[] = []
    for (const agent of workflow.agents.values()) {
      entries.push({
        content: agent.phase !== undefined ? `${agent.label} (${agent.phase})` : agent.label,
        priority: PLAN_PRIORITY,
        status: agent.status,
      })
    }
    if (workflow.phase !== undefined) {
      entries.push({ content: `phase: ${workflow.phase}`, priority: PLAN_PRIORITY, status: 'in_progress' })
    }
    if (entries.length === 0) {
      entries.push({ content: `workflow: ${workflow.name}`, priority: PLAN_PRIORITY, status: 'in_progress' })
    }
    notify({
      sessionId: sessionOf(record).id,
      update: { sessionUpdate: 'plan', entries },
    })
  }

  /**
   * Resolve the live workflow state for one run event: the owning record must
   * exist and hold the matching run (a stale event from an older run is
   * ignored). Shared by every workflow handler.
   */
  const workflowOf = (info: { id: unknown }, record: SessionRecord | undefined): SessionRecord | undefined => {
    if (record === undefined || record.workflow === undefined || record.workflow.runId !== String(info.id)) return undefined
    return record
  }

  /** One brief subagent plan entry (P2-1); the stop reason annotates failures. */
  const emitSubagentPlan = (record: SessionRecord, provider: string, id: string, status: PlanEntryStatus, stopReason?: string): void => {
    const label = stopReason !== undefined && stopReason !== 'completed'
      ? `subagent: ${provider} (${id}) (${stopReason})`
      : `subagent: ${provider} (${id})`
    notify({
      sessionId: sessionOf(record).id,
      update: {
        sessionUpdate: 'plan',
        entries: [{ content: label, priority: PLAN_PRIORITY, status }],
      },
    })
  }

  // Workflow runs render as plan updates: phases become progress groups and
  // each `agent()` call becomes a task entry that settles (completed, with the
  // outcome annotated) when it ends (P2-1). The last update reports the run's
  // stop reason.
  ctx.on('workflow/start', (info) => {
    const record = turnOwner()
    if (record === undefined) return
    record.workflow = {
      runId: String(info.id),
      name: info.meta.name,
      phase: undefined,
      agents: new Map(),
    }
    emitWorkflowPlan(record)
  })

  ctx.on('workflow/phase', (info, title) => {
    const record = workflowOf(info, turnOwner())
    if (record === undefined || record.workflow === undefined) return
    record.workflow.phase = title
    emitWorkflowPlan(record)
  })

  ctx.on('workflow/agent-start', (info, agent) => {
    const record = workflowOf(info, turnOwner())
    if (record === undefined || record.workflow === undefined) return
    record.workflow.agents.set(agent.seq, { label: agent.label, phase: agent.phase, status: 'in_progress' })
    emitWorkflowPlan(record)
  })

  ctx.on('workflow/agent-end', (info, agent) => {
    const record = workflowOf(info, turnOwner())
    if (record === undefined || record.workflow === undefined) return
    const entry = record.workflow.agents.get(agent.seq)
    if (entry !== undefined) {
      // The call is over whatever its outcome: settle the entry and annotate
      // a non-clean outcome so the client never sees a spinning task.
      entry.status = 'completed'
      if (agent.outcome !== 'completed') entry.label = `${entry.label} (${agent.outcome})`
    }
    emitWorkflowPlan(record)
  })

  ctx.on('workflow/end', (info, result) => {
    const record = workflowOf(info, turnOwner())
    if (record === undefined || record.workflow === undefined) return
    // Any stop reason ends the run: settle the entry and let the content carry
    // the outcome so the client never sees a spinning task.
    notify({
      sessionId: sessionOf(record).id,
      update: {
        sessionUpdate: 'plan',
        entries: [{
          content: `workflow: ${record.workflow.name} (${result.stopReason})`,
          priority: PLAN_PRIORITY,
          status: 'completed',
        }],
      },
    })
    record.workflow = undefined
  })

  // Subagent runs render as brief plan updates: the child appears as a task
  // when it starts and flips to completed when it settles (P2-1). This shares
  // the single plan slot with todo/workflow updates — the last writer wins.
  ctx.on('subagent/start', (info) => {
    const record = turnOwner()
    if (record === undefined) return
    emitSubagentPlan(record, info.provider, String(info.id), 'in_progress')
  })

  ctx.on('subagent/end', (info) => {
    const record = turnOwner()
    if (record === undefined) return
    // Any stop reason ends the run: settle the entry; a non-clean reason is
    // annotated in the label so the client never sees a spinning task.
    emitSubagentPlan(record, info.provider, String(info.id), 'completed', info.stopReason)
  })

  /**
   * Build per-agent options from bridge config, always carrying a concrete
   * route (subagent-fix Plan A). Delegation inherits provider/model from the
   * parent's `AgentOptions` (`resolveChildAgentOptions` in dsh-subagent), so
   * an absent model would fail the child's first prompt assembly (`{{model}}`
   * has no value). Resolution mirrors `selectionFor`'s chain minus the
   * request-header leg, which only exists once the session is live: explicit
   * config wins, then the saved agent-default-model, then the composition
   * defaults. `syncAgentRoute` refines the pair after adoption (resume
   * restores the persisted header).
   */
  const agentOptions = (): { provider: string; model: string } => {
    if (config.provider !== undefined || config.model !== undefined) {
      return {
        provider: config.provider ?? DEFAULT_PROVIDER,
        model: config.model ?? DEFAULT_MODEL,
      }
    }
    const current = defaultModelService()?.currentSelection()
    return {
      provider: current?.provider ?? DEFAULT_PROVIDER,
      model: current?.model ?? DEFAULT_MODEL,
    }
  }

  /** The live session behind a bridge record (shortens the common navigation). */
  const sessionOf = (record: SessionRecord): Session => record.agent.session

  /** Wrap an owned agent handle in the bridge's per-session protocol state. */
  const makeRecord = (handle: { agent: Agent; dispose: () => Promise<void> }): SessionRecord => ({
    agent: handle.agent,
    dispose: () => handle.dispose(),
    inflight: undefined,
    permission: undefined,
    allowedTools: new Set(),
    workflow: undefined,
    selection: undefined,
    preset: undefined,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  })

  /** ISO timestamp of the log's last event, or null for an empty log. */
  const lastUpdated = (events: readonly { time: number }[]): string | null =>
    events.length > 0 ? new Date(events[events.length - 1]!.time).toISOString() : null

  /** Install the per-session model selection and record the running preset (P4b). */
  const adoptRecord = (record: SessionRecord): void => {
    installModelSelection(record.agent.ctx, selectionFor(record))
    record.preset = resolveSessionPreset(record.agent.session) ?? presetRoster()?.defaultId
    // Refine the creation-time route to the resolved selection: for a resumed
    // session this is the persisted request header's provider/model, which
    // `agentOptions()` could not know before the agent existed.
    syncAgentRoute(record)
  }

  /** Resume a persisted session into the bridge, rejecting when already open. */
  const resumeRecord = async (sessionId: SessionId, cwd: string): Promise<SessionRecord> => {
    assertOpen()
    if (sessions.has(sessionId)) throw invalidParams(`session is already open: ${sessionId}`)
    const handle = await agents.resume({
      resumeSessionId: sessionId,
      // Always explicit: children inherit the parent's provider/model from
      // AgentOptions, so the pair must never be left absent (subagent fix).
      agentOptions: agentOptions(),
      setup: composeSetup(sessionId, cwd),
    })
    if (closed) {
      await handle.dispose()
      throw internalError('connection closed during session/resume')
    }
    const record = makeRecord(handle)
    sessions.set(sessionId, record)
    adoptRecord(record)
    return record
  }

  /** Replay a session's full durable log as wire notifications (session/load). */
  const replaySession = (record: SessionRecord): void => {
    const events = sessionOf(record).events
    for (const event of events) emitForEvent(record, event, true)
  }

  /** Fold the latest title for a live or reconstructed session. */
  const sessionTitle = (session: Session): string | undefined => {
    return ctx.sessionTitle?.get(session)?.title
  }

  /** Resolve `SessionInfo` rows: live records first, then persisted sessions. */
  const collectSessionInfos = async (): Promise<SessionInfo[]> => {
    const infos: SessionInfo[] = []
    const seen = new Set<SessionId>()
    for (const record of sessions.values()) {
      const session = sessionOf(record)
      const events = session.events
      seen.add(session.id)
      infos.push({
        sessionId: session.id,
        cwd: session.header.cwd ?? '',
        title: sessionTitle(session) ?? null,
        updatedAt: lastUpdated(events),
      })
    }
    const persistence = ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      let headers: { id: SessionId; cwd?: string; createdAt: number }[] = []
      try {
        headers = await persistence.list()
      } catch (error: unknown) {
        logger.warn(`dshacp: sessionPersistence.list failed: ${String(error)}`)
        headers = []
      }
      for (const header of headers) {
        if (seen.has(header.id)) continue
        let title: string | null = null
        let updatedAt: string | null = null
        try {
          const preparation = await persistence.prepare(header.id)
          const session = preparation.session
          title = sessionTitle(session) ?? null
          updatedAt = lastUpdated(session.events)
          preparation[Symbol.dispose]()
        } catch (error: unknown) {
          logger.warn(`dshacp: preparing persisted session ${header.id} failed: ${String(error)}`)
        }
        infos.push({
          sessionId: header.id,
          cwd: header.cwd ?? '',
          title,
          updatedAt,
        })
      }
    }
    return infos
  }

  /** Delete a persisted session's artifacts after the live agent (if any) is gone. */
  const deletePersisted = async (sessionId: SessionId): Promise<void> => {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return
    let headers: { id: SessionId }[] = []
    try {
      headers = await persistence.list()
    } catch (error: unknown) {
      logger.warn(`dshacp: sessionPersistence.list failed: ${String(error)}`)
      return
    }
    const header = headers.find(candidate => candidate.id === sessionId)
    if (header === undefined || typeof persistence.locate !== 'function') return
    const location = persistence.locate(header as Parameters<typeof persistence.locate>[0])
    if (location === undefined) return
    const { unlink } = await import('node:fs/promises')
    try {
      await unlink(location.path)
    } catch (error: unknown) {
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') logger.warn(`dshacp: removing persisted session artifact failed: ${String(error)}`)
    }
  }

  const makeAgent = (connection: AgentSideConnection): AcpAgent => {
    conn = connection
    return {
      initialize(params: InitializeRequest): Promise<InitializeResponse> {
        // P3 gate: hybrid file writes are only offered when the client can
        // apply them (Zed advertises fs.writeTextFile: true).
        clientFsWrite = params.clientCapabilities?.fs?.writeTextFile === true
        // P4b gate: elicitation is only offered when the client can render it
        // (Zed advertises elicitation.form).
        clientElicitation = params.clientCapabilities?.elicitation?.form !== undefined
        // Single-version agent: the spec's "same version if supported, else
        // the latest supported" both resolve to this server's one version.
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'dshacp', version: '0.1.0' },
          agentCapabilities: {
            loadSession: true,
            // P5: image pasting is accepted (and handled by this bridge, which
            // lands each image in tmp and injects its path as text); audio and
            // embedded resources remain unsupported and are rejected.
            promptCapabilities: { image: true },
            sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
            // P4b: HTTP MCP servers are forwarded into dsh-mcp-client. Stdio is
            // mandatory per the spec (no capability field); sse/acp are not
            // advertised and are skipped when a client sends them anyway.
            mcpCapabilities: { http: true },
            auth: {},
          },
          authMethods: [],
        })
      },

      authenticate(_params: AuthenticateRequest): Promise<void> {
        // No authMethods are advertised, so the client must not call this; the
        // SDK still dispatches it, so answer harmlessly.
        return Promise.resolve()
      },

      async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
        assertOpen()
        validateSessionParams(params)
        const sessionId = SessionId(randomUUID())
        // Resolve the starting preset before the session exists so the header
        // can record it (a preset discovered during setup could never reach
        // the snapshot); setup then mounts exactly what the header names. A
        // broken default fails loud here, exactly like the web app.
        const presets = presetRoster()
        const presetId = presets !== undefined ? (await presets.resolve(undefined)).id : undefined
        const handle = await agents.create({
          sessionId,
          meta: {
            cwd: params.cwd,
            ...(presetId !== undefined ? { agentPreset: presetId } : {}),
          },
          // Always explicit: children inherit the parent's provider/model from
          // AgentOptions, so the pair must never be left absent (subagent fix).
          agentOptions: agentOptions(),
          setup: composeSetup(sessionId, params.cwd),
        })
        /* v8 ignore next 4 -- a real stdio close can race an in-flight create. */
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/new')
        }
        const record = makeRecord(handle)
        sessions.set(sessionId, record)
        adoptRecord(record)
        // Zed-forwarded MCP servers mount before the response so the first
        // prompt already sees their tools (a failed server never fails the
        // session; D12).
        await forwardMcpServers(params.mcpServers)
        void pushAvailableCommands(record)
        return { sessionId, configOptions: await buildConfigOptions(record) }
      },

      async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
        const sessionId = SessionId(params.sessionId)
        const record = await resumeRecord(sessionId, params.cwd)
        replaySession(record)
        void pushAvailableCommands(record)
        await forwardMcpServers(params.mcpServers)
        return { configOptions: await buildConfigOptions(record) }
      },

      async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
        const record = await resumeRecord(SessionId(params.sessionId), params.cwd)
        void pushAvailableCommands(record)
        await forwardMcpServers(params.mcpServers)
        return { configOptions: await buildConfigOptions(record) }
      },

      async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        const catalog = await applyConfigOption(record, params)
        return { configOptions: await buildConfigOptions(record, catalog) }
      },

      async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
        assertOpen()
        let infos = await collectSessionInfos()
        if (params.cwd !== undefined && params.cwd !== null) {
          infos = infos.filter(info => info.cwd === params.cwd)
        }
        return { sessions: infos }
      },

      async deleteSession(params: DeleteSessionRequest): Promise<void> {
        const sessionId = SessionId(params.sessionId)
        const record = sessions.get(sessionId)
        if (record !== undefined) {
          settlePermission(record, 'cancelled')
          settlePrompt(record, 'cancelled')
          sessions.delete(sessionId)
          // Flush the durable log before disposal so no buffered events are lost,
          // then unlink the artifact below.
          await ctx.sessions.flush(sessionOf(record))
          await record.dispose()
        }
        await deletePersisted(sessionId)
      },

      async closeSession(params: CloseSessionRequest): Promise<void> {
        const record = requireSession(SessionId(params.sessionId))
        settlePermission(record, 'cancelled')
        settlePrompt(record, 'cancelled')
        sessions.delete(sessionOf(record).id)
        record.agent.cancel({ kind: 'user' })
        // Flush the durable log before disposal so a later session/list (which
        // reads storage) and a later load/resume see the complete history.
        await ctx.sessions.flush(sessionOf(record))
        await record.dispose()
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        if (record.inflight !== undefined) {
          throw invalidParams('a prompt is already in flight for this session')
        }
        if (promptHasUnsupportedContent(params.prompt)) {
          throw invalidParams('only text, resource_link, and image prompt content is supported')
        }

        // P5: image blocks carry base64 raster payloads. Validate the mime
        // against the whitelist, decode, and land each image in os.tmpdir()
        // (the host process writes directly, so the model-side fs sandbox
        // never applies). The default model route is text-only, so the bridge
        // injects the absolute path as a textual marker and lets the model
        // call the qwenmm vision_chat / ocr tools to read it.
        const imageRefs: string[] = []
        for (const block of params.prompt) {
          if (block.type !== 'image') continue
          const ext = imageExtensionForMime(block.mimeType)
          if (ext === undefined) {
            throw invalidParams(`unsupported pasted image type: ${block.mimeType} (supported: png/jpeg/webp/gif)`)
          }
          const data = Buffer.from(block.data, 'base64')
          if (data.length > MAX_PASTED_IMAGE_BYTES) {
            throw invalidParams(`pasted image too large: ${data.length} bytes (max ${MAX_PASTED_IMAGE_BYTES})`)
          }
          const path = join(tmpdir(), `dshacp-${randomUUID()}${ext}`)
          await writeFile(path, data)
          imageRefs.push(path)
        }

        const text = acpPromptToText(params.prompt) + imageRefs.map(path =>
          `\n[用户粘贴的图片: ${path} — 如需理解图片内容，请调用 qwenmm 的 vision_chat / ocr 工具]\n`,
        ).join('')
        if (text.trim().length === 0) throw invalidParams('empty prompt')

        // Not driving a retired agent is this bridge's contract: an
        // agent-loop-only reload disposes the loop's agents while the bridge
        // record survives, so validate the record against the live registry
        // before sending — a disposed machine would accept the item silently.
        if (agents.get(record.agent.id) !== record.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
        const stopReason = await new Promise<StopReason>((resolve, reject) => {
          // Arm the slot before followup() so a listener-driven synchronous
          // turn cannot slip past correlation; a synchronous followup()
          // failure (invalid input) must free the slot again or the session
          // would reject every later prompt as already in flight.
          const inflight: NonNullable<SessionRecord['inflight']> = {
            resolve, reject, messageId: message.id, turn: undefined, endReason: undefined,
          }
          record.inflight = inflight
          try {
            record.agent.followup(message)
            /* v8 ignore start -- future-proofing guard, see above */
          } catch (error: unknown) {
            record.inflight = undefined
            const detail = error instanceof Error ? error.message : String(error)
            throw internalError(`prompt was not queued: ${detail}`)
          }
          /* v8 ignore stop */
          // Settlement waits for whole-agent idle: a correlated turn/end arms
          // `endReason`, while a turnless slot (admission discarded the
          // prompt) stays cancelled. Other producers may run further turns
          // before quiescence; the prompt settles only when the agent stops.
          void record.agent.whenIdle().then(() => {
            if (record.inflight !== inflight) return
            record.inflight = undefined
            const end = inflight.endReason
            inflight.resolve(end === undefined ? 'cancelled' : turnEndToStopReason(end))
          })
        })
        return { stopReason }
      },

      cancel(params: CancelNotification): Promise<void> {
        const record = sessions.get(SessionId(params.sessionId))
        if (record === undefined) return Promise.resolve()
        settlePermission(record, 'cancelled')
        record.agent.cancel({ kind: 'user' })
        settlePrompt(record, 'cancelled')
        return Promise.resolve()
      },
    }
  }

  /* v8 ignore next 4 -- production stdio wiring; tests inject config.stream. */
  const stream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  conn = new AgentSideConnection(makeAgent, stream)

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    sessions.clear()
    // Stop the bridge's own work before any await: a descendant drain can block
    // on persistence or scoped cleanup, and the top-level agents must not keep
    // running model and tool calls for its whole duration.
    for (const record of records) {
      settlePermission(record, 'rejected')
      record.agent.cancel({ kind: 'user' })
      settlePrompt(record, 'cancelled')
    }
    quiescing = (async () => {
      // Continuable subagents outlive the turn that started them, and their
      // Activations own descendant teardown. Drain only these sessions' forests
      // child-first BEFORE disposing the top-level agents, so no descendant is
      // left holding a runtime its owner already released and another frontend
      // sharing this Context remains live.
      const subagents = ctx.get('subagents') as ContinuableDrain | undefined
      if (subagents !== undefined) {
        try {
          await subagents.drainContinuableDescendants(records.map(record => record.agent))
        } catch (error: unknown) {
          logger.warn(`dshacp: continuable subagent teardown failed: ${String(error)}`)
        }
      }
      const disposals = await Promise.allSettled(records.map(record => record.dispose()))
      const failures: unknown[] = []
      for (const result of disposals) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      // Zed-forwarded MCP servers are process-global mounts owned by this
      // bridge; they unwind with the connection (P4b).
      const mcpMounts = [...mountedMcp.values()]
      mountedMcp.clear()
      const mcpResults = await Promise.allSettled(mcpMounts.map(async (mount) => {
        const mounted = await mount
        if (mounted !== undefined) await mounted.dispose()
      }))
      for (const result of mcpResults) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        const detail = failures.map(failure => errorChain(failure)).join('; ')
        throw new AggregateError(
          failures,
          `DSHACP agent teardown failed for ${failures.length} session(s): ${detail}`,
        )
      }
    })()
    return quiescing
  }

  /* v8 ignore start -- production transport rejection and teardown failure. */
  void conn.closed
    .catch((error: unknown) => {
      logger.warn(`dshacp: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`dshacp: connection-close teardown failed: ${String(error)}`)
    })
  /* v8 ignore stop */

  ctx.effect(() => quiesce, 'dshacp.connection')
}
