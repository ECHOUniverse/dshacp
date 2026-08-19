/**
 * Pure translation between the DSH lifecycle and the ACP v1 wire.
 *
 * The stop-reason mapping reuses the official `turnEndToStopReason` codec from
 * `@deepseek-ai/dsh-acp` (same vocabulary and semantics); the tool-kind and
 * todo-to-plan mappings are DSHACP-owned and tunable.
 *
 * @module dshacp/codec
 */

import { isAbsolute, join } from 'node:path'
import type {
  ContentBlock as AcpContentBlock,
  PlanEntry,
  StopReason,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from '@agentclientprotocol/sdk'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-session'

/** One file change, aligned with DSH `FileDiff` / ACP v1 `Diff`. */
export interface FileDiff {
  path: string
  oldText: string | null
  newText: string
}

/**
 * Map a harness turn ending to ACP's terminal reason vocabulary.
 * @param reason - harness turn outcome.
 * @returns the closest legal ACP stop reason.
 */
export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    // `cancelled` is reserved for explicit client cancellation (`session/cancel`)
    // and disposal, both settled out of band; a turn aborted by a hook or
    // another owner is ordinary quiescence and reports `end_turn`.
    case 'aborted':
      return 'end_turn'
    case 'interrupted':
      return 'cancelled'
    case 'blocked':
    case 'error':
      return 'end_turn'
    /* v8 ignore next 2 -- TurnEndReason is closed and every member is handled above */
    default:
      return 'end_turn'
  }
}

/**
 * Flatten an ACP prompt's baseline blocks to text. Text blocks concatenate
 * verbatim; resource links become explicit textual references so a baseline
 * client can point at files without the bridge silently dropping that context.
 * @param prompt - supported ACP prompt blocks.
 * @returns text in wire order, with resource links rendered as bracketed references.
 */
export function acpPromptToText(prompt: readonly AcpContentBlock[]): string {
  return prompt.flatMap((block): string[] => {
    switch (block.type) {
      case 'text':
        return [block.text]
      case 'resource_link':
        return [`\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`]
      default:
        return []
    }
  }).join('')
}

/**
 * Whether a prompt carries content beyond the ACP baseline. The spec requires
 * every agent to accept `text` and `resource_link`; richer inline payloads
 * (image, audio, embedded resource) are optional capabilities this bridge does
 * not advertise, so they are rejected rather than silently dropped. Since P5
 * the bridge advertises (and handles) `image`, so only `audio` and `resource`
 * are rejected.
 * @param prompt - ACP prompt blocks to inspect.
 * @returns `true` when any block is neither `text`, `resource_link`, nor `image`.
 */
export function promptHasUnsupportedContent(prompt: readonly AcpContentBlock[]): boolean {
  return prompt.some(block => block.type !== 'text' && block.type !== 'resource_link' && block.type !== 'image')
}

/** Accepted raster mime types → on-disk extension (P5). */
const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/**
 * Map a pasted image's mime type to the on-disk extension used for its tmp
 * file. Only raster formats the qwenmm vision tools can read are accepted;
 * anything else (svg, tiff, …) is rejected by the bridge before decoding.
 * @param mimeType - the ACP image block's mime type.
 * @returns the extension (with leading dot), or `undefined` when unsupported.
 */
export function imageExtensionForMime(mimeType: string): string | undefined {
  return IMAGE_MIME_EXTENSIONS[mimeType.trim().toLowerCase()]
}

/**
 * Map a DSH tool name to an ACP tool kind for client rendering (DESIGN §6).
 *
 * The mapping is deliberately rule-based over exact-name matching so plugin
 * tools (ssh stack, future tools) degrade to sensible kinds without a code
 * change; prefix families are matched below.
 *
 * @param name - the DSH tool name as the model called it.
 * @returns the closest ACP `ToolKind`.
 */
export function toolKindForName(name: string): ToolKind {
  const n = name.toLowerCase()
  if (n === 'bash' || n === 'terminal' || n.startsWith('ssh_')) return 'execute'
  if (n === 'read') return 'read'
  if (n === 'write' || n === 'edit') return 'edit'
  if (n === 'glob' || n === 'grep' || n === 'web_search' || n.endsWith('search')) return 'search'
  if (n === 'subagent' || n === 'subagent_fork' || n === 'ralph' || n === 'send_message' || n === 'list_agents') {
    return 'think'
  }
  return 'other'
}

/**
 * Derive a human-readable `tool_call` title for the ACP client.
 *
 * ACP's `ToolCall.title` is defined as "what the tool is doing", and Zed
 * renders it verbatim as the card body for `kind: execute` tools, so pasting
 * the tool name (`bash`) produces a card that never shows the actual command.
 * For execute-class tools we therefore use the `command` argument — matching
 * the DSH harness's own UI presentation (`presentBashCall`: `title: command`)
 * — and fall back to the tool name when the argument is absent or malformed.
 *
 * Delegation and control tools use their model-facing arguments; other
 * non-execute tools keep the tool name.
 *
 * @param name - the DSH tool name as the model called it.
 * @param args - the parsed arguments (`parseToolArguments` output).
 * @returns the title to send as `tool_call.title`.
 */
export function toolTitleForCall(name: string, args: unknown): string {
  const n = name.toLowerCase()
  if (n === 'write') {
    const path = extractFilePath(args)
    return path !== undefined ? `Write ${truncate(path, EDIT_TITLE_MAX_LENGTH)}` : name
  }
  if (n === 'edit') {
    const path = extractFilePath(args)
    return path !== undefined ? `Edit ${truncate(path, EDIT_TITLE_MAX_LENGTH)}` : name
  }
  if (n === 'subagent') {
    const description = extractStringField(args, 'description')
    return description !== undefined
      ? truncate(`Subagent: ${description}`, SUBAGENT_TITLE_MAX_LENGTH)
      : name
  }
  if (n === 'subagent_fork') {
    const description = extractStringField(args, 'description')
    return description !== undefined
      ? truncate(`Subagent fork: ${description}`, SUBAGENT_TITLE_MAX_LENGTH)
      : name
  }
  if (n === 'ralph') {
    const description = extractStringField(args, 'description')
    return description !== undefined
      ? truncate(`Ralph: ${description}`, SUBAGENT_TITLE_MAX_LENGTH)
      : name
  }
  if (n === 'send_message') {
    const target = extractStringField(args, 'subagent_id') ?? extractStringField(args, 'agent_id')
    return target !== undefined
      ? truncate(`Send to ${target}`, SUBAGENT_TITLE_MAX_LENGTH)
      : name
  }
  if (toolKindForName(name) !== 'execute') return name
  const command = extractCommand(args)
  if (command === undefined) return name
  const trimmed = command.trim()
  return trimmed.length > 0 ? truncate(trimmed, EXECUTE_TITLE_MAX_LENGTH) : name
}

/** Max length of an execute-tool card title before truncation with an ellipsis. */
const EXECUTE_TITLE_MAX_LENGTH = 80

/** Max length of a write/edit card title path segment before truncation. */
const EDIT_TITLE_MAX_LENGTH = 80

/** Max length of a delegation-tool card title before truncation. */
const SUBAGENT_TITLE_MAX_LENGTH = 80

/** Max prompt excerpt shown on a subagent card body. */
const SUBAGENT_PROMPT_MAX_LENGTH = 200

/** Max body text appended to a subagent card (results, notifications). */
const SUBAGENT_BODY_MAX_LENGTH = 1200

/** Whether a tool name is a provider-bound subagent delegation tool. */
export function isSubagentDelegationTool(name: string): boolean {
  const n = name.toLowerCase()
  return n === 'subagent' || n === 'subagent_fork'
}

/** Parsed background launch confirmation from a delegation tool result. */
export interface SubagentLaunchInfo {
  kind: 'continuable' | 'background'
  id: string
}

const CONTINUABLE_LAUNCH_RE = /^started subagent (\S+)$/
const BACKGROUND_JOB_LAUNCH_RE = /^started background subagent job (\S+)$/

/**
 * Recognize the canonical one-line launch confirmations from
 * `@deepseek-ai/dsh-tool-subagent`.
 * @param resultText - rendered tool result text.
 * @returns launch kind and id, or `undefined` when not a launch line.
 */
export function parseSubagentLaunch(resultText: string): SubagentLaunchInfo | undefined {
  const trimmed = resultText.trim()
  const continuable = CONTINUABLE_LAUNCH_RE.exec(trimmed)
  if (continuable !== null) return { kind: 'continuable', id: continuable[1]! }
  const background = BACKGROUND_JOB_LAUNCH_RE.exec(trimmed)
  if (background !== null) return { kind: 'background', id: background[1]! }
  return undefined
}

/** Inputs for rendering one replaceable subagent card body. */
export interface SubagentCardInput {
  toolName: string
  args: unknown
  phase: 'call' | 'running' | 'launched' | 'report' | 'settled' | 'failed' | 'result'
  childId?: string
  jobId?: string
  resultText?: string
  stopReason?: string
  closing?: string
  notification?: string
}

/**
 * Build the full replaceable text body for a subagent delegation card.
 * @param input - card phase and optional lifecycle details.
 * @returns multi-line card text for ACP `tool_call.content`.
 */
export function subagentCardText(input: SubagentCardInput): string {
  const lines: string[] = []
  const description = extractStringField(input.args, 'description')
  const prompt = extractStringField(input.args, 'prompt')
  const background = extractBooleanField(input.args, 'run_in_background') === true

  if (description !== undefined) lines.push(`Task: ${description}`)
  if (prompt !== undefined) lines.push(`Prompt: ${truncate(prompt, SUBAGENT_PROMPT_MAX_LENGTH)}`)

  if (input.phase === 'call') {
    lines.push(background ? 'Mode: background' : 'Mode: foreground')
    return lines.join('\n')
  }

  if (input.childId !== undefined) lines.push(`Child: ${input.childId}`)
  if (input.jobId !== undefined) lines.push(`Job: ${input.jobId}`)

  switch (input.phase) {
    case 'running':
      lines.push('Status: running')
      break
    case 'launched':
      lines.push('Status: started in background')
      if (input.resultText !== undefined) lines.push(input.resultText)
      break
    case 'report':
      lines.push('Status: report received')
      if (input.notification !== undefined) {
        lines.push(truncate(input.notification, SUBAGENT_BODY_MAX_LENGTH))
      }
      break
    case 'settled':
      lines.push(`Status: finished (${input.stopReason ?? 'completed'})`)
      if (input.closing !== undefined && input.closing.length > 0) {
        lines.push('Closing message:')
        lines.push(truncate(input.closing, SUBAGENT_BODY_MAX_LENGTH))
      }
      break
    case 'failed':
      lines.push(`Status: failed (${input.stopReason ?? 'error'})`)
      if (input.closing !== undefined && input.closing.length > 0) {
        lines.push('Partial output:')
        lines.push(truncate(input.closing, SUBAGENT_BODY_MAX_LENGTH))
      }
      break
    case 'result':
      lines.push('Status: completed')
      if (input.resultText !== undefined) {
        lines.push('Result:')
        lines.push(truncate(input.resultText, SUBAGENT_BODY_MAX_LENGTH))
      }
      break
  }

  return lines.join('\n')
}

/**
 * Wrap plain text as a single ACP v1 tool-call content block.
 * @param text - card body text.
 * @returns one `content` item suitable for `tool_call.content`.
 */
export function textToToolCallContent(text: string): ToolCallContent[] {
  return [{ type: 'content', content: { type: 'text', text } }]
}

/**
 * Flatten LLM content blocks to plain text for card bodies.
 * @param blocks - message or tool content blocks.
 * @returns concatenated text blocks, or an empty string.
 */
export function contentBlocksToText(
  blocks: readonly { type: string; text?: string }[],
): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Detect subagent report/settlement injections that should patch a delegation
 * card instead of appearing in the main conversation stream.
 * @param source - durable message source from a `user/message` event.
 * @returns notification kind and child session id, or `undefined`.
 */
export function subagentNotificationSource(
  source: unknown,
): { kind: 'report' | 'settled'; senderSessionId: string } | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  const senderSessionId = record.senderSessionId
  if (typeof senderSessionId !== 'string' || senderSessionId.length === 0) return undefined
  if (record.kind === 'subagent-report') return { kind: 'report', senderSessionId }
  if (record.kind === 'subagent-settled') return { kind: 'settled', senderSessionId }
  return undefined
}

/** Pull a non-empty string field from parsed tool arguments. */
function extractStringField(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Pull a boolean field from parsed tool arguments. */
function extractBooleanField(args: unknown, key: string): boolean | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Pull a command string out of a tool's parsed arguments. Execute-class tools
 * carry the command text under `command` (bash/terminal) or `cmd`/`command`
 * (ssh_* family); unknown shapes yield `undefined` so callers fall back.
 */
function extractCommand(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  for (const key of ['command', 'cmd']) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

/** Pull `file_path` from write/edit tool arguments. */
function extractFilePath(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>).file_path
  return typeof value === 'string' ? value : undefined
}

/**
 * Resolve a tool's model-facing path to an absolute path for ACP wire.
 * Relative paths join against the session cwd; absolute paths pass through.
 * @param path - the model-supplied file path.
 * @param cwd - the session working directory (may be empty when unknown).
 * @returns the absolute path, or the original when cwd is absent.
 */
export function resolveToolPath(path: string, cwd: string | undefined): string {
  if (isAbsolute(path)) return path
  if (cwd !== undefined && cwd.length > 0) return join(cwd, path)
  return path
}

/** Whether `value` is a valid {@link FileDiff}. */
function isFileDiff(value: unknown): value is FileDiff {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, oldText, newText } = value as Record<string, unknown>
  return typeof path === 'string'
    && (oldText === null || typeof oldText === 'string')
    && typeof newText === 'string'
}

/**
 * Narrow opaque `tool/result.meta` to non-empty file diffs. Malformed metadata
 * returns `undefined` so presentation can fall back instead of throwing.
 * @param meta - result metadata from the session event.
 * @returns validated hunks, or `undefined` for absent or malformed data.
 */
export function parseDiffsFromMeta(meta: unknown): FileDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0 || !diffs.every(isFileDiff)) return undefined
  return diffs
}

/**
 * Derive call-time preview diffs for write/edit, matching DSH `presentCall`.
 * @param name - the DSH tool name.
 * @param args - parsed tool arguments.
 * @returns preview diffs, or `undefined` for other tools.
 */
export function callTimeDiffsForTool(name: string, args: unknown): FileDiff[] | undefined {
  const n = name.toLowerCase()
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const filePath = record.file_path
  if (typeof filePath !== 'string') return undefined
  if (n === 'write') {
    const content = record.content
    if (typeof content !== 'string') return undefined
    return [{ path: filePath, oldText: null, newText: content }]
  }
  if (n === 'edit') {
    const oldString = record.old_string
    const newString = record.new_string
    if (typeof oldString !== 'string' || typeof newString !== 'string') return undefined
    return [{ path: filePath, oldText: oldString || null, newText: newString }]
  }
  return undefined
}

/**
 * Derive result-time diffs for write/edit, matching DSH `presentResult`.
 * Prefers `meta.diffs` hunks; write on a new file yields an empty meta array,
 * so callers fall back to call-time args.
 * @param name - the DSH tool name.
 * @param args - parsed tool arguments from the pending call.
 * @param meta - optional result metadata.
 * @returns applied diffs, or `undefined` when none can be derived.
 */
export function resultDiffsForTool(name: string, args: unknown, meta: unknown): FileDiff[] | undefined {
  const fromMeta = parseDiffsFromMeta(meta)
  if (fromMeta !== undefined) return fromMeta
  const n = name.toLowerCase()
  if (n === 'write') return callTimeDiffsForTool(name, args)
  if (n === 'edit') return undefined
  return undefined
}

/**
 * Map file diffs to ACP v1 `ToolCallContent` diff blocks with absolute paths.
 * @param diffs - one or more file changes.
 * @param cwd - session working directory for relative-path resolution.
 * @returns ACP content blocks, empty when `diffs` is empty.
 */
export function fileDiffsToAcpContent(diffs: readonly FileDiff[], cwd: string | undefined): ToolCallContent[] {
  return diffs.map(diff => ({
    type: 'diff' as const,
    path: resolveToolPath(diff.path, cwd),
    oldText: diff.oldText,
    newText: diff.newText,
  }))
}

/**
 * Derive follow-along file locations from diffs with absolute paths.
 * @param diffs - one or more file changes.
 * @param cwd - session working directory for relative-path resolution.
 * @returns ACP location entries, empty when `diffs` is empty.
 */
export function locationsFromDiffs(diffs: readonly FileDiff[], cwd: string | undefined): ToolCallLocation[] {
  return diffs.map(diff => ({ path: resolveToolPath(diff.path, cwd) }))
}

/** Truncate to `max` runes, appending `…` only when actually cut. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

/**
 * Map DSH todo entries to ACP plan entries. DSH todos carry no priority; the
 * DESIGN fixes `priority` to `medium`. Status passes through unchanged.
 * @param todos - the DSH whole-list snapshot.
 * @returns ACP plan entries in the same order.
 */
export function todoToPlanEntries(todos: readonly TodoItem[]): PlanEntry[] {
  return todos.map(todo => ({
    content: todo.content,
    priority: 'medium' as const,
    status: todo.status,
  }))
}

/**
 * Parse a raw tool-arguments JSON string for `rawInput`. Invalid JSON (a
 * malformed model emission) is preserved verbatim as a string rather than
 * dropped, so the client still sees what the model produced.
 * @param raw - the raw arguments string.
 * @returns the parsed object, or the raw string when unparseable.
 */
export function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * Render a tool result message as `rawOutput` text: the concatenated text
 * blocks of the result content (unwrapping `tool-result` blocks), or the
 * tool's error identity when it failed.
 * @param content - the tool result content blocks (tool-result wrappers or plain blocks).
 * @param error - optional error identity.
 * @returns a short renderable string.
 */
export function toolResultToText(
  content: readonly { type: string; text?: string; content?: readonly { type: string; text?: string }[] }[],
  error?: { name: string; code: string },
): string {
  if (error !== undefined) return `[tool error ${error.code}] ${error.name}`
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
      for (const inner of block.content) {
        if (inner.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : '(no text output)'
}

/** Separator between the provider route and the model id in a model-option value. */
export const MODEL_OPTION_SEPARATOR = ':'

/**
 * Encode a provider/model pair as the `model` config-option value. Model ids
 * are not unique across providers (deepseek-v4-flash may exist on several
 * routes), so the option value must carry the provider — otherwise two
 * providers offering the same model collide in the client's picker and the
 * current value matches both.
 * @param provider - the provider route (catalog group id).
 * @param model - the provider-owned model id.
 * @returns the option value, e.g. `opencode-go:deepseek-v4-flash`.
 */
export function encodeModelOption(provider: string, model: string): string {
  return `${provider}${MODEL_OPTION_SEPARATOR}${model}`
}

/**
 * Split a model-option value back into provider and model. A value without
 * the separator is a bare model id (a legacy `default_config_options` entry);
 * the caller resolves it against the model catalog.
 * @param value - the option value received on `session/set_config_option`.
 * @returns the parsed pair, or `undefined` for a bare model id.
 */
export function parseModelOption(value: string): { provider: string; model: string } | undefined {
  const index = value.indexOf(MODEL_OPTION_SEPARATOR)
  if (index <= 0 || index === value.length - 1) return undefined
  return { provider: value.slice(0, index), model: value.slice(index + 1) }
}
