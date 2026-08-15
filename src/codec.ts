/**
 * Pure translation between the DSH lifecycle and the ACP v1 wire.
 *
 * The stop-reason mapping reuses the official `turnEndToStopReason` codec from
 * `@deepseek-ai/dsh-acp` (same vocabulary and semantics); the tool-kind and
 * todo-to-plan mappings are DSHACP-owned and tunable.
 *
 * @module dshacp/codec
 */

import type { ContentBlock as AcpContentBlock, PlanEntry, StopReason, ToolKind } from '@agentclientprotocol/sdk'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-session'

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
 * not advertise, so they are rejected rather than silently dropped.
 * @param prompt - ACP prompt blocks to inspect.
 * @returns `true` when any block is neither `text` nor `resource_link`.
 */
export function promptHasUnsupportedContent(prompt: readonly AcpContentBlock[]): boolean {
  return prompt.some(block => block.type !== 'text' && block.type !== 'resource_link')
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
