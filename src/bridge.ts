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
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage, errorChain, type ContentBlock } from '@deepseek-ai/dsh-llm'
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
// Declaration-merge the `agent-preset/selected` session event (P4b mode switch).
import type {} from '@deepseek-ai/dsh-agent-presets'
// Declaration-merge subagent lifecycle events observed by the bridge.
import type {} from '@deepseek-ai/dsh-subagent'
import { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import {
  acpPromptToText,
  callTimeDiffsForTool,
  contentBlocksToText,
  encodeModelOption,
  fileDiffsToAcpContent,
  imageExtensionForMime,
  isSubagentDelegationTool,
  locationsFromDiffs,
  parseModelOption,
  parseSubagentLaunch,
  parseToolArguments,
  promptHasUnsupportedContent,
  resultDiffsForTool,
  subagentCardText,
  subagentNotificationSource,
  textToToolCallContent,
  todoToPlanEntries,
  toolKindForName,
  toolResultToText,
  toolTitleForCall,
  turnEndToStopReason,
} from './codec.ts'

export const name = 'dshacp-bridge'
/** The bridge creates and owns agents; the title service and store serve the wire. */
export const inject = ['agents', 'sessionTitle', 'sessions', 'userQuestions', 'llm']

/** Default permission-request timeout: fail-closed after this long (DESIGN §7). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

/** Default user-question (elicitation) timeout: fail-closed after this long (DESIGN P4b). */
export const DEFAULT_ELICITATION_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Default cap on how long a settled prompt waits for trailing background work
 * (owned bash / background-subagent jobs) to converge before force-settling
 * (prompt-settlement progress note). Same order as the elicitation timeout:
 * a genuinely-stuck background job must never leave the client without a
 * response forever, but ordinary long-running background work gets the full
 * budget. On timeout the prompt settles as if the background were absent —
 * strictly no worse than the pre-gate behavior.
 */
export const DEFAULT_BACKGROUND_SETTLE_TIMEOUT_MS = 30 * 60 * 1000

/** ACP config-option ids for model / thinking / mode (DESIGN §12.4). */
export const MODEL_OPTION_ID = 'model'
export const THINKING_OPTION_ID = 'thought_level'
export const MODE_OPTION_ID = 'mode'

/**
 * Side-channel file name for the per-session model/thinking record (plan A,
 * session restore): the session's own last-chosen selection, stored as a
 * sibling of its durable JSONL log. `request/header` only records a selection
 * once an LLM request actually fires, so a switch made but never sent would
 * otherwise be lost — this file restores it on session/load and session/resume.
 */
export const SESSION_SELECTION_FILE = 'model-selection.json'

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
 * The char-per-token heuristic shared with the token-meter surface estimate
 * (`@deepseek-ai/dsh-token-meter` `CHARS_PER_TOKEN`). Used only by the pi-ai
 * reasoning fallback ({@link estimateReasoningTokens}).
 */
const CHARS_PER_TOKEN = 4

/**
 * Estimate reasoning tokens from `reasoning` content blocks — the pi-ai
 * (opencode-go) path fallback. `dsh-llm-pi-ai`'s `mapUsage` drops
 * `reasoningTokens`, so for that route the thinking text assembled into the
 * `assistant/message` content is the only available signal; the
 * deepseek-official (`dsh-llm-deepseek`) path reports exact
 * `reasoningTokens` and never consults this estimate.
 *
 * The estimate matches the token-meter surface heuristic
 * (`⌈text.length / CHARS_PER_TOKEN⌉` per block, no block overhead), so it
 * stays on the same scale as the compaction pressure measurement. Thinking
 * text absent → 0, so non-thinking output counts into `used` in full.
 * Exported for unit tests; usage accounting lives in `apply`'s
 * `accumulateUsage`.
 */
export const estimateReasoningTokens = (content: readonly ContentBlock[] | undefined): number =>
  content === undefined
    ? 0
    : content.reduce(
      (total, block) => block.type === 'reasoning' ? total + Math.ceil(block.text.length / CHARS_PER_TOKEN) : total,
      0,
    )

/**
 * The context-occupancy total reported as `usage_update.used` — a SNAPSHOT
 * of one call, not a running sum: `input + cacheRead + non-reasoning output`.
 * `inputTokens + cacheReadTokens` already equals the full prompt just sent
 * (input is net of the cache hit, cacheRead restores the hit prefix), so
 * summing them across steps would count every cached prefix anew; the caller
 * passes the current step's values to keep the bar at true occupancy.
 * `reasoningTokens` is a subset of `outputTokens` (DeepSeek's
 * `completion_tokens` already includes reasoning) and its `reasoning_content`
 * does not participate in the next turn's context (DeepSeek Thinking Mode),
 * so it is subtracted from output — never merely excluded from the sum.
 * `cacheWriteTokens` is input-side cache-write traffic, not context
 * occupancy, and is not a DeepSeek wire field; it is likewise excluded. The
 * clamp keeps a pathological over-report of reasoning from driving `used`
 * negative. Exported for unit tests (the pi-ai reasoning fallback itself
 * lives in {@link estimateReasoningTokens}).
 */
export const usedTokens = (
  input: number,
  cacheRead: number,
  output: number,
  reasoning: number,
): number => input + cacheRead + Math.max(0, output - reasoning)

/**
 * The single continuable-subagent teardown the bridge needs. Declared
 * structurally so this package does not depend on the subagent seam for one
 * shutdown hook; an absent service means nothing continuable was materialized.
 */
interface ContinuableDrain {
  drainContinuableDescendants(parents: readonly Agent[]): Promise<void>
}

/**
 * Minimal subagent registry surface for correlating lifecycle events with the
 * parent ACP session without importing the full seam.
 */
interface SubagentRegistryView {
  listChildren(parentSessionId: SessionId): Promise<readonly { kind: string; id: SessionId }[]>
}

/** Live state for one open subagent delegation card in an ACP session. */
interface OpenSubagentCard {
  toolName: string
  args: unknown
  childId?: string
  jobId?: string
  background: boolean
  text: string
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
  /**
   * How long a settled prompt waits for this session's trailing background
   * work (owned bash / background-subagent jobs) to converge before
   * force-settling anyway (prompt-settlement progress note). Default
   * {@link DEFAULT_BACKGROUND_SETTLE_TIMEOUT_MS}. Absent (or a missing
   * `jobs` service) falls back to the pre-gate settlement on `whenIdle()`.
   */
  backgroundSettleTimeoutMs?: number
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
}

export const Config: Schema<BridgeConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  approvalTimeoutMs: Schema.natural().default(DEFAULT_APPROVAL_TIMEOUT_MS),
  elicitationTimeoutMs: Schema.natural().default(DEFAULT_ELICITATION_TIMEOUT_MS),
  hybridFileWrites: Schema.boolean().default(false),
  backgroundSettleTimeoutMs: Schema.natural().default(DEFAULT_BACKGROUND_SETTLE_TIMEOUT_MS),
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
  /**
   * Release the active settle-gate's resources (job observer + fallback timer)
   * when the inflight is settled out-of-band (cancel/close/delete) — the gate's
   * own `.then` guard already ignores a stale inflight, but its timer and
   * `onJobsChanged` listener would otherwise leak until they fire.
   */
  settleCleanup: (() => void) | undefined
  /** Pushed permission request awaiting the client; answered `cancelled` on cancel/close. */
  permission: {
    settle: (outcome: ApprovalOutcome) => void
    timer: ReturnType<typeof setTimeout>
  } | undefined
  /** Tool names the user granted `allow_always`; their calls skip the push. */
  allowedTools: Set<string>
  /** Per-session model selection (P4b): mutated by the `model`/`thought_level` config options. */
  selection: ModelSelectionRef | undefined
  /** The preset id this session runs (P4b): set at setup, updated by mode switches. */
  preset: string | undefined
  /**
   * Session-wide token accounting. The fields accumulate for cost/statistics;
   * `usage_update.used` is computed per call as a snapshot instead (see
   * accumulateUsage) so long tool-loops do not re-count cached prefixes.
   */
  usage: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning: number
  }
  /** Pending tool calls keyed by callId — args retained for result-time diff mapping. */
  pendingToolCalls: Map<string, { name: string; args: unknown }>
  /** Open subagent delegation cards keyed by parent tool call id. */
  openSubagents: Map<string, OpenSubagentCard>
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
  const backgroundSettleTimeoutMs = config.backgroundSettleTimeoutMs ?? DEFAULT_BACKGROUND_SETTLE_TIMEOUT_MS
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

  /**
   * Plan A (per-session side channel): the sibling file recording this
   * session's own last-chosen model/thinking, next to its durable JSONL log —
   * `dirname(locate(session.header).path)/model-selection.json`. `locate` is
   * pure path computation (no I/O), so an absent backend, an absent `locate`,
   * or an unmaterialized session all resolve as "no path" — the deployment
   * then simply has no per-session restore (matching `deletePersisted`).
   */
  const sessionSelectionPath = (record: SessionRecord): string | undefined => {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined || typeof persistence.locate !== 'function') return undefined
    const location = persistence.locate(sessionOf(record).header)
    if (location === undefined) return undefined
    return join(dirname(location.path), SESSION_SELECTION_FILE)
  }

  /**
   * Read this session's own last-chosen model/thinking (plan-A restore).
   * Best effort: an absent file reads as no record and the chain falls through
   * to the request header / deployment default; a malformed file is ignored
   * with a warning, never a thrown error.
   */
  const readSessionSelection = (record: SessionRecord): ModelSelection | undefined => {
    const path = sessionSelectionPath(record)
    if (path === undefined) return undefined
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error: unknown) {
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') logger.warn(`dshacp: reading the session model selection failed: ${String(error)}`)
      return undefined
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ModelSelection>
      if (typeof parsed.provider !== 'string' || typeof parsed.model !== 'string') return undefined
      return {
        provider: parsed.provider,
        model: parsed.model,
        ...(typeof parsed.reasoningEffort === 'string'
          ? { reasoningEffort: parsed.reasoningEffort as ReasoningEffortId }
          : {}),
      }
    } catch (error: unknown) {
      logger.warn(`dshacp: the session model selection is malformed and ignored: ${String(error)}`)
      return undefined
    }
  }

  /**
   * Persist the session's own chosen model/thinking to its side-channel file
   * (plan-A restore): written on every model/thinking switch, so `session/load`
   * and `session/resume` restore the session's own last choice even when no
   * request was ever sent. Best effort — a write failure warns and never fails
   * the switch; the session directory is created on first switch because the
   * JSONL log is materialized lazily. Runs alongside `persistSelection`, which
   * keeps serving the independent "remember the last combination for fresh
   * sessions" feature.
   */
  const persistSessionSelection = (record: SessionRecord): void => {
    const path = sessionSelectionPath(record)
    if (path === undefined) return
    const selected = selectionFor(record).current
    if (selected === undefined) return
    const payload = JSON.stringify(selected, null, 2)
    void (async () => {
      try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, payload, 'utf8')
      } catch (error: unknown) {
        logger.warn(`dshacp: the model selection applies to this session but was not saved for restore: ${String(error)}`)
      }
    })()
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
        // ① Plan A: this session's own side-channel record. It beats the
        // request header because a user's most recent switch is newer than the
        // last actual request — e.g. switch to pro and send, then switch to
        // flash without sending; restore must show flash. Sessions created
        // before this file existed fall through unchanged.
        const stored = readSessionSelection(record)
        if (stored !== undefined) return stored
        // ② The last actually-sent request header (backward-compatible restore
        // for pre-side-channel sessions).
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

  /** Find an open delegation card already bound to a child session id. */
  const findCardByChildId = (childId: string): { record: SessionRecord; toolCallId: string } | undefined => {
    for (const record of sessions.values()) {
      for (const [toolCallId, entry] of record.openSubagents) {
        if (entry.childId === childId) return { record, toolCallId }
      }
    }
    return undefined
  }

  /** Patch one delegation card's replaceable body and optional terminal status. */
  const patchDelegationCard = (
    record: SessionRecord,
    toolCallId: string,
    patch: { text?: string; status?: 'in_progress' | 'completed' | 'failed'; finalize?: boolean },
  ): void => {
    const entry = record.openSubagents.get(toolCallId)
    if (entry === undefined) return
    if (patch.text !== undefined) entry.text = patch.text
    notify({
      sessionId: sessionOf(record).id,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        ...(patch.text !== undefined ? { content: textToToolCallContent(entry.text) } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      },
    })
    if (patch.finalize === true) record.openSubagents.delete(toolCallId)
  }

  /**
   * Resolve which parent-session delegation card a child lifecycle event belongs
   * to — prefer an explicit child binding, else a single unbound card on the
   * owning parent session.
   */
  const resolveDelegationBinding = async (
    childId: SessionId,
  ): Promise<{ record: SessionRecord; toolCallId: string; entry: OpenSubagentCard } | undefined> => {
    const bound = findCardByChildId(childId)
    if (bound !== undefined) {
      const entry = bound.record.openSubagents.get(bound.toolCallId)
      if (entry !== undefined) return { ...bound, entry }
    }

    const subagents = ctx.get('subagents') as SubagentRegistryView | undefined
    if (subagents === undefined) return undefined

    for (const record of sessions.values()) {
      let ownsChild = false
      try {
        const children = await subagents.listChildren(sessionOf(record).id)
        ownsChild = children.some(entry => entry.kind === 'child' && entry.id === childId)
      } catch (error: unknown) {
        logger.warn(`dshacp: listChildren failed: ${String(error)}`)
        continue
      }
      if (!ownsChild) continue

      const unbound = [...record.openSubagents.entries()].filter(([, entry]) => entry.childId === undefined)
      if (unbound.length === 1) {
        const [toolCallId, entry] = unbound[0]!
        return { record, toolCallId, entry }
      }
    }
    return undefined
  }

  const settlePrompt = (record: SessionRecord, reason: StopReason): void => {
    const inflight = record.inflight
    if (inflight === undefined) return
    // Release the settle-gate's timer / job observer so an out-of-band settle
    // (cancel/close/delete) never leaks them.
    if (record.settleCleanup !== undefined) {
      record.settleCleanup()
      record.settleCleanup = undefined
    }
    record.inflight = undefined
    inflight.resolve(reason)
  }

  /**
   * The subset of the `ctx.jobs` capability (dsh-jobs) the settle gate needs,
   * declared structurally so this package does not depend on the job seam for
   * one convergence wait; an absent service means no background-jobs tracking
   * is possible and the gate passes immediately.
   */
  interface JobRegistryView {
    list(caller?: Agent): readonly { status: string }[]
    onJobsChanged(listener: (owner: Agent | undefined) => void): () => void
  }

  /**
   * Wait until this session's owned background job set holds no job still
   * converging (`running` / `stopping`). `ctx.jobs` is an optional capability:
   * a composition without a job service resolves immediately, preserving the
   * pre-gate behavior. The visible set is re-read on every `onJobsChanged`
   * edge (registration, stopping transitions, settlement, removal), so a job
   * registered after the wait starts is still caught. Returns a disposer so an
   * out-of-band settle (cancel/close/delete) can drop the observer without
   * waiting for the jobs to converge.
   * @param record - the live session whose owner bounds job visibility.
   * @returns `{ wait, dispose }` — `wait` resolves once no owned non-terminal
   *   job remains (or immediately when no job service is present), and
   *   `dispose` unsubscribes the observer.
   */
  const backgroundIdle = (record: SessionRecord): { wait: Promise<void>; dispose: () => void } => {
    /* v8 ignore next 4 -- the jobs service is always mounted in the shipped composition. */
    const jobs = ctx.get('jobs') as JobRegistryView | undefined
    if (jobs === undefined) {
      return { wait: Promise.resolve(), dispose: () => {} }
    }
    const isTerminal = (status: string): boolean =>
      status === 'completed' || status === 'killed' || status === 'failed'
    let settled = false
    let reader: (() => void) | undefined
    let resolveWait: () => void
    const wait = new Promise<void>((resolve) => {
      resolveWait = resolve
    })
    const dispose = (): void => {
      reader?.()
      reader = undefined
    }
    const check = (): void => {
      if (settled) return
      if (jobs.list(record.agent).some(job => !isTerminal(job.status))) return
      settled = true
      dispose()
      resolveWait()
    }
    // Subscribe first, then check: a job registered between the initial
    // `list()` and this `onJobsChanged` registration still holds the gate open
    // until it settles.
    reader = jobs.onJobsChanged(() => check())
    check()
    return { wait, dispose }
  }

  /**
   * Settle one inflight only once the whole-agent is idle AND this session's
   * trailing background work has converged. The background-convergence wait is
   * bounded by {@link backgroundSettleTimeoutMs}: the timer starts only once
   * the whole-agent is idle (so a slow turn is never force-settled mid-call),
   * and on expiry we settle as if background were absent — strictly no worse
   * than the pre-gate behavior. The `record.inflight !== inflight` guard keeps
   * a later cancel/close/delete authoritative.
   */
  const settleWhenConverged = (record: SessionRecord, inflight: NonNullable<SessionRecord['inflight']>): void => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposeBackground: (() => void) | undefined
    // One shared teardown so the two cleanup paths (out-of-band settle vs a
    // settled gate) can never drift apart in what they release.
    const teardown = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      disposeBackground?.()
      disposeBackground = undefined
    }
    const forceSettle = (): void => {
      if (settled) return
      settled = true
      teardown()
      if (record.inflight !== inflight) return
      record.settleCleanup = undefined
      record.inflight = undefined
      const end = inflight.endReason
      inflight.resolve(end === undefined ? 'cancelled' : turnEndToStopReason(end))
    }
    record.settleCleanup = teardown

    let idle = false
    let backgroundInactive = false
    // Settle once whole-agent idle AND no owned background job is converging:
    // either condition alone still leaves the prompt unsettled. When idle but
    // background remains, arm the fallback so a stuck job never holds the
    // response forever.
    const attemptSettle = (): void => {
      if (idle && backgroundInactive) return forceSettle()
      if (idle && !backgroundInactive && timer === undefined) {
        timer = setTimeout(() => {
          logger.warn(
            `dshacp: settling prompt for session ${sessionOf(record).id} after background-settle timeout of ${backgroundSettleTimeoutMs}ms`,
          )
          forceSettle()
        }, backgroundSettleTimeoutMs)
        timer.unref?.()
      }
    }
    // Condition ① — whole-agent quiescence (the existing settlement signal).
    void record.agent.whenIdle().then(() => {
      idle = true
      attemptSettle()
    })
    // Condition ② — this session's owned background jobs converged.
    const backgroundState = backgroundIdle(record)
    disposeBackground = () => backgroundState.dispose()
    void backgroundState.wait.then(() => {
      backgroundInactive = true
      attemptSettle()
    })
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
      persistSessionSelection(record)
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
      persistSessionSelection(record)
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

  /**
   * Fold one call's token accounting into the session record and report the
   * current context occupancy as `usage_update.used`.
   *
   * The cumulative fields (`record.usage.*`) are kept for cost/statistics, but
   * `used` is a SNAPSHOT of this call rather than a running total: each step's
   * `inputTokens + cacheReadTokens` equals the full prompt just sent (the
   * cached prefix is re-read every step), so summing them across a long
   * tool-loop turns every cached step into new occupancy and the bar explodes
   * (observed: a 5-turn / 107-step session reaching 12.3M on a 1M window).
   * Reporting the latest step keeps the bar at the true context size.
   */
  const accumulateUsage = (
    record: SessionRecord,
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number },
    content?: readonly ContentBlock[],
  ): void => {
    record.usage.input += usage.inputTokens
    record.usage.output += usage.outputTokens
    record.usage.cacheRead += usage.cacheReadTokens ?? 0
    record.usage.cacheWrite += usage.cacheWriteTokens ?? 0
    // Exact reasoning wins (deepseek-official path); the pi-ai adapter drops
    // `reasoningTokens`, so the thinking text is estimated as the fallback.
    // `record.usage.reasoning` therefore accumulates a mix of exact and
    // estimated values per provider path (see estimateReasoningTokens).
    const reasoning = usage.reasoningTokens ?? estimateReasoningTokens(content)
    record.usage.reasoning += reasoning
    // "Tokens currently in context" (this step's snapshot): input + cache-read
    // + non-reasoning output — see usedTokens for why reasoning is subtracted,
    // not merely excluded, and why cacheWrite stays out.
    const used = usedTokens(usage.inputTokens, usage.cacheReadTokens ?? 0, usage.outputTokens, reasoning)
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
        const notification = subagentNotificationSource(event.data.source)
        if (notification !== undefined && !replay) {
          const binding = findCardByChildId(notification.senderSessionId)
          if (binding !== undefined) {
            const entry = binding.record.openSubagents.get(binding.toolCallId)
            if (entry !== undefined) {
              const notificationText = contentBlocksToText(event.data.content)
              entry.text = subagentCardText({
                toolName: entry.toolName,
                args: entry.args,
                phase: notification.kind === 'report' ? 'report' : 'settled',
                childId: notification.senderSessionId,
                notification: notificationText,
                ...(notification.kind === 'settled' ? { stopReason: 'completed' } : {}),
              })
              patchDelegationCard(binding.record, binding.toolCallId, {
                text: entry.text,
                ...(notification.kind === 'settled' && entry.background
                  ? { status: 'completed', finalize: true }
                  : {}),
              })
            }
          }
          return
        }
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
        // The message content is passed alongside usage so the pi-ai path
        // (opencode-go), whose adapter drops `reasoningTokens`, can still
        // deduct thinking tokens from `used` via the content's `reasoning`
        // blocks (see estimateReasoningTokens). The deepseek-official path
        // ignores the content and uses the exact `reasoningTokens`.
        if (event.data.usage !== undefined) {
          accumulateUsage(record, event.data.usage, event.data.message.content)
        }
        return
      }
      case 'tool/call': {
        const { callId, name, arguments: raw } = event.data
        const parsed = parseToolArguments(raw)
        record.pendingToolCalls.set(String(callId), { name, args: parsed })
        const cwd = sessionOf(record).header.cwd
        const callDiffs = callTimeDiffsForTool(name, parsed)
        let callContent = callDiffs !== undefined ? fileDiffsToAcpContent(callDiffs, cwd) : undefined
        const callLocations = callDiffs !== undefined ? locationsFromDiffs(callDiffs, cwd) : undefined
        if (isSubagentDelegationTool(name)) {
          const cardText = subagentCardText({ toolName: name, args: parsed, phase: 'call' })
          record.openSubagents.set(String(callId), {
            toolName: name,
            args: parsed,
            background: typeof parsed === 'object'
              && parsed !== null
              && (parsed as Record<string, unknown>).run_in_background === true,
            text: cardText,
          })
          callContent = textToToolCallContent(cardText)
        }
        notify({
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: callId,
            title: toolTitleForCall(name, parsed),
            kind: toolKindForName(name),
            status: 'pending',
            rawInput: parsed,
            ...(callContent !== undefined && callContent.length > 0 ? { content: callContent } : {}),
            ...(callLocations !== undefined && callLocations.length > 0 ? { locations: callLocations } : {}),
          },
        })
        // The tool starts executing right away: flip the card to "running"
        // (in_progress) so it never sits at pending while it runs — long
        // calls (e.g. a foreground subagent) show a spinner. Sent in the same
        // frame, the client processes card-then-transition in order.
        notify({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: callId,
            status: 'in_progress',
          },
        })
        return
      }
      case 'tool/result': {
        const { message, error, meta } = event.data
        const toolCallId = message.content[0]?.toolCallId
        if (toolCallId === undefined) return
        const pending = record.pendingToolCalls.get(String(toolCallId))
        record.pendingToolCalls.delete(String(toolCallId))
        const cwd = sessionOf(record).header.cwd
        const failed = error !== undefined
        const resultText = toolResultToText(message.content, error)

        if (pending !== undefined && isSubagentDelegationTool(pending.name)) {
          const entry = record.openSubagents.get(String(toolCallId))
          const launch = !failed ? parseSubagentLaunch(resultText) : undefined
          if (launch !== undefined && entry !== undefined) {
            entry.background = true
            if (launch.kind === 'continuable') entry.childId = launch.id
            else entry.jobId = launch.id
            entry.text = subagentCardText({
              toolName: pending.name,
              args: pending.args,
              phase: 'launched',
              childId: entry.childId,
              jobId: entry.jobId,
              resultText,
            })
            notify({
              sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status: 'in_progress',
                content: textToToolCallContent(entry.text),
                rawOutput: resultText,
              },
            })
            return
          }

          if (entry !== undefined) {
            entry.text = subagentCardText({
              toolName: pending.name,
              args: pending.args,
              phase: failed ? 'failed' : 'result',
              childId: entry.childId,
              jobId: entry.jobId,
              resultText,
              stopReason: failed ? 'error' : undefined,
            })
            record.openSubagents.delete(String(toolCallId))
          }
          notify({
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: failed ? 'failed' : 'completed',
              content: textToToolCallContent(entry?.text ?? resultText),
              rawOutput: resultText,
            },
          })
          return
        }

        const resultDiffs = !failed && pending !== undefined
          ? resultDiffsForTool(pending.name, pending.args, meta)
          : undefined
        const resultContent = resultDiffs !== undefined ? fileDiffsToAcpContent(resultDiffs, cwd) : undefined
        const resultLocations = resultDiffs !== undefined ? locationsFromDiffs(resultDiffs, cwd) : undefined
        const hasDiffContent = resultContent !== undefined && resultContent.length > 0
        notify({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: failed ? 'failed' : 'completed',
            ...(hasDiffContent ? { content: resultContent } : {}),
            ...(resultLocations !== undefined && resultLocations.length > 0 ? { locations: resultLocations } : {}),
            ...(failed || !hasDiffContent
              ? { rawOutput: toolResultToText(message.content, error) }
              : {}),
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

  ctx.on('subagent/start', (info) => {
    void resolveDelegationBinding(info.id).then((binding) => {
      if (binding === undefined) return
      binding.entry.childId = info.id
      binding.entry.text = subagentCardText({
        toolName: binding.entry.toolName,
        args: binding.entry.args,
        phase: 'running',
        childId: info.id,
      })
      patchDelegationCard(binding.record, binding.toolCallId, { text: binding.entry.text })
    }).catch((error: unknown) => {
      logger.warn(`dshacp: subagent/start card patch failed: ${String(error)}`)
    })
  })

  ctx.on('subagent/end', (info) => {
    const binding = findCardByChildId(info.id)
    if (binding === undefined) return
    const entry = binding.record.openSubagents.get(binding.toolCallId)
    if (entry === undefined) return

    const closing = info.lastAssistantMessage !== undefined
      ? contentBlocksToText(info.lastAssistantMessage)
      : undefined
    const failed = info.stopReason !== 'completed'
    entry.text = subagentCardText({
      toolName: entry.toolName,
      args: entry.args,
      phase: failed ? 'failed' : 'settled',
      childId: info.id,
      jobId: entry.jobId,
      stopReason: String(info.stopReason),
      closing,
    })

    if (entry.background) {
      patchDelegationCard(binding.record, binding.toolCallId, {
        text: entry.text,
        status: failed ? 'failed' : 'completed',
        finalize: true,
      })
      return
    }

    patchDelegationCard(binding.record, binding.toolCallId, { text: entry.text })
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
    settleCleanup: undefined,
    permission: undefined,
    allowedTools: new Set(),
    selection: undefined,
    preset: undefined,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    pendingToolCalls: new Map(),
    openSubagents: new Map(),
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
    // The plan-A side-channel selection file dies with its session (ENOENT is
    // ordinary: the session may predate the feature or never be switched).
    for (const path of [location.path, join(dirname(location.path), SESSION_SELECTION_FILE)]) {
      try {
        await unlink(path)
      } catch (error: unknown) {
        const code = (error as { code?: string }).code
        if (code !== 'ENOENT') logger.warn(`dshacp: removing persisted session artifact failed: ${String(error)}`)
      }
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
          // Settlement waits for whole-agent idle AND this session's trailing
          // background work (owned bash / background-subagent jobs) to converge:
          // without the second condition, a prompt whose turn ended but whose
          // spawned background job still runs would settle `end_turn` early and
          // Zed's panel would show the conversation ended while the work
          // continues (prompt-settlement progress note). The gate resolves only
          // when both hold, or when the background timeout force-settles (a
          // fallback that is no worse than the pre-gate behavior).
          settleWhenConverged(record, inflight)
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
