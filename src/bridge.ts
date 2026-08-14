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
  type DeleteSessionRequest,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type PlanEntryStatus,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionInfo,
  type SessionNotification,
  type StopReason,
  type Stream,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk'
import type { Agent, AgentSetup } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId, type Session, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
// Side-effect type imports: declaration-merge the event maps answered below.
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-workflow'
import { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import {
  acpPromptToText,
  parseToolArguments,
  promptHasUnsupportedContent,
  todoToPlanEntries,
  toolKindForName,
  toolResultToText,
  turnEndToStopReason,
} from './codec.ts'
import { pickDefined } from './options.ts'

export const name = 'dshacp-bridge'
/** The bridge creates and owns agents; the title service and store serve the wire. */
export const inject = ['agents', 'sessionTitle', 'sessions']

/** Default permission-request timeout: fail-closed after this long (DESIGN §7). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

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

/** Plugin config: provider/model selection and the approval fail-closed timeout. */
export interface BridgeConfig {
  /** Provider route for created agents; absent reuses the composition default. */
  provider?: string
  /** Model name for created agents; absent reuses the composition default. */
  model?: string
  /** How long a pushed permission request waits for the client before rejecting (fail-closed). */
  approvalTimeoutMs?: number
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
  const sessions = new Map<SessionId, SessionRecord>()
  const approvalTimeoutMs = config.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  let closed = false
  /** Whether the client advertised `fs.writeTextFile` at initialize (P3 gate). */
  let clientFsWrite = false
  let conn: AgentSideConnection

  /** Return the bridge-owned record for an agent, rejecting same-id impostors. */
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
    // "Tokens currently in context": input + output + cache + thought tokens.
    const used = record.usage.input + record.usage.output + record.usage.cacheRead + record.usage.cacheWrite + record.usage.reasoning
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
    // `mcpServers` is a required v1 param; accept and ignore in P1 (DESIGN §5).
    if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
      logger.info('dshacp: additionalDirectories is accepted but not applied in P1')
    }
  }

  /**
   * P3 hybrid mode: when enabled AND the client advertised
   * `clientCapabilities.fs.writeTextFile`, return an agent setup that shadows
   * the global `write` tool with a per-agent tool delegating to the client's
   * `fs/write_text_file`. Zed applies the edit to its buffers and offers
   * per-hunk diff review; everything else stays DSH-owned. Relative paths
   * resolve against the session cwd (the ACP wire requires absolute paths).
   */
  const hybridSetup = (sessionId: SessionId, cwd: string): AgentSetup | undefined => {
    if (config.hybridFileWrites !== true || !clientFsWrite) return undefined
    return (agentCtx) => {
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

  /** Build per-agent options from bridge config without assigning absent optional fields. */
  const agentOptions = (): { provider?: string; model?: string } =>
    pickDefined(config, ['provider', 'model'])

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
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  })

  /** ISO timestamp of the log's last event, or null for an empty log. */
  const lastUpdated = (events: readonly { time: number }[]): string | null =>
    events.length > 0 ? new Date(events[events.length - 1]!.time).toISOString() : null

  /** Resume a persisted session into the bridge, rejecting when already open. */
  const resumeRecord = async (sessionId: SessionId, cwd: string): Promise<SessionRecord> => {
    assertOpen()
    if (sessions.has(sessionId)) throw invalidParams(`session is already open: ${sessionId}`)
    const handle = await agents.resume({
      resumeSessionId: sessionId,
      ...(Object.keys(agentOptions()).length > 0 ? { agentOptions: agentOptions() } : {}),
      ...(hybridSetup(sessionId, cwd) !== undefined ? { setup: hybridSetup(sessionId, cwd) } : {}),
    })
    if (closed) {
      await handle.dispose()
      throw internalError('connection closed during session/resume')
    }
    const record = makeRecord(handle)
    sessions.set(sessionId, record)
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
        // Single-version agent: the spec's "same version if supported, else
        // the latest supported" both resolve to this server's one version.
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'dshacp', version: '0.1.0' },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {},
            sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
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
        const handle = await agents.create({
          sessionId,
          meta: { cwd: params.cwd },
          ...(Object.keys(agentOptions()).length > 0 ? { agentOptions: agentOptions() } : {}),
          ...(hybridSetup(sessionId, params.cwd) !== undefined ? { setup: hybridSetup(sessionId, params.cwd) } : {}),
        })
        /* v8 ignore next 4 -- a real stdio close can race an in-flight create. */
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/new')
        }
        sessions.set(sessionId, makeRecord(handle))
        return { sessionId }
      },

      async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
        const sessionId = SessionId(params.sessionId)
        const record = await resumeRecord(sessionId, params.cwd)
        replaySession(record)
        return {}
      },

      async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
        await resumeRecord(SessionId(params.sessionId), params.cwd)
        return {}
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
          throw invalidParams('only text and resource_link prompt content is supported')
        }
        const text = acpPromptToText(params.prompt)
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
