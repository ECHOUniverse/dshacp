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
import { isAbsolute } from 'node:path'
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
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionInfo,
  type SessionNotification,
  type StopReason,
  type Stream,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
// Side-effect type imports: declaration-merge the event maps answered below.
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-session-title'
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

export const name = 'dshacp-bridge'
/** The bridge creates and owns agents; the title service and store serve the wire. */
export const inject = ['agents', 'sessionTitle', 'sessions']

/** Default permission-request timeout: fail-closed after this long (DESIGN §7). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

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
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
}

export const Config: Schema<BridgeConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  approvalTimeoutMs: Schema.natural().default(DEFAULT_APPROVAL_TIMEOUT_MS),
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
    const used = record.usage.input + record.usage.output + record.usage.cacheRead + record.usage.cacheWrite
    if (used <= 0) return
    const size = record.agent.session.requestContext()?.contextWindow ?? 0
    notify({
      sessionId: record.agent.session.id,
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
    const sessionId = record.agent.session.id
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
    if (record === undefined || record.agent.session !== session) return
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
    if (record === undefined || inflight === undefined || inflight.turn === turn) return
    record.inflight = undefined
    inflight.reject(internalError(`turn failed: ${errorChain(error)}`))
  })

  // Permission requests are pushed to the client (DESIGN §7): hold the
  // synchronous waterfall, ask over ACP, backfill the outcome, and fail closed
  // on timeout or disconnect. One-shot choices only; never infer a durable
  // grant from an unknown client response.
  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    const callId = request.callId
    if (record === undefined || callId === undefined) return next()
    if (closed) return Promise.resolve('rejected')
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => resolve('rejected'), approvalTimeoutMs)
      timer.unref?.()
      const settle = (outcome: ApprovalOutcome): void => {
        clearTimeout(timer)
        resolve(outcome)
      }
      record.permission = { settle, timer }
      const toolCall: ToolCallUpdate = {
        toolCallId: String(callId),
        title: request.toolName,
        kind: toolKindForName(request.toolName),
        status: 'pending',
      }
      void conn.requestPermission({
        sessionId: record.agent.session.id,
        toolCall,
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      }).then(({ outcome }) => {
        if (outcome.outcome === 'cancelled') settle('cancelled')
        else if (outcome.optionId === 'allow-once') settle('allowed-once')
        else settle('rejected')
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

  /** Build per-agent options from bridge config without assigning absent optional fields. */
  const agentOptions = (): { provider?: string; model?: string } => ({
    ...config.provider !== undefined ? { provider: config.provider } : {},
    ...config.model !== undefined ? { model: config.model } : {},
  })

  /** Resume a persisted session into the bridge, rejecting when already open. */
  const resumeRecord = async (sessionId: SessionId, cwd: string): Promise<SessionRecord> => {
    assertOpen()
    if (sessions.has(sessionId)) throw invalidParams(`session is already open: ${sessionId}`)
    const handle = await agents.resume({
      resumeSessionId: sessionId,
      ...(Object.keys(agentOptions()).length > 0 ? { agentOptions: agentOptions() } : {}),
    })
    if (closed) {
      await handle.dispose()
      throw internalError('connection closed during session/resume')
    }
    const record: SessionRecord = {
      agent: handle.agent,
      dispose: () => handle.dispose(),
      inflight: undefined,
      permission: undefined,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    }
    sessions.set(sessionId, record)
    return record
  }

  /** Replay a session's full durable log as wire notifications (session/load). */
  const replaySession = (record: SessionRecord): void => {
    const events = record.agent.session.events
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
      const session = record.agent.session
      const events = session.events
      seen.add(session.id)
      infos.push({
        sessionId: session.id,
        cwd: session.header.cwd ?? '',
        title: sessionTitle(session) ?? null,
        updatedAt: events.length > 0 ? new Date(events[events.length - 1]!.time).toISOString() : null,
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
          const events = session.events
          updatedAt = events.length > 0 ? new Date(events[events.length - 1]!.time).toISOString() : null
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
      initialize(_params: InitializeRequest): Promise<InitializeResponse> {
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
        })
        /* v8 ignore next 4 -- a real stdio close can race an in-flight create. */
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/new')
        }
        sessions.set(sessionId, {
          agent: handle.agent,
          dispose: () => handle.dispose(),
          inflight: undefined,
          permission: undefined,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        })
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
          await ctx.sessions.flush(record.agent.session)
          await record.dispose()
        }
        await deletePersisted(sessionId)
      },

      async closeSession(params: CloseSessionRequest): Promise<void> {
        const record = requireSession(SessionId(params.sessionId))
        settlePermission(record, 'cancelled')
        settlePrompt(record, 'cancelled')
        sessions.delete(record.agent.session.id)
        record.agent.cancel({ kind: 'user' })
        // Flush the durable log before disposal so a later session/list (which
        // reads storage) and a later load/resume see the complete history.
        await ctx.sessions.flush(record.agent.session)
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
