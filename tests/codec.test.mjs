// Pure codec unit tests — no model, no process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acpPromptToText,
  encodeModelOption,
  parseModelOption,
  parseToolArguments,
  promptHasUnsupportedContent,
  todoToPlanEntries,
  toolKindForName,
  toolResultToText,
  turnEndToStopReason,
} from '../lib/codec.js'

test('turnEndToStopReason maps the DESIGN §6 table', () => {
  assert.equal(turnEndToStopReason({ kind: 'completed' }), 'end_turn')
  assert.equal(turnEndToStopReason({ kind: 'max-tokens' }), 'max_tokens')
  assert.equal(turnEndToStopReason({ kind: 'aborted', reason: { kind: 'user' } }), 'end_turn')
  assert.equal(turnEndToStopReason({ kind: 'interrupted' }), 'cancelled')
  assert.equal(turnEndToStopReason({ kind: 'blocked' }), 'end_turn')
  assert.equal(turnEndToStopReason({ kind: 'error', error: { message: 'x', code: 'UNKNOWN' } }), 'end_turn')
})

test('toolKindForName maps the DESIGN §6 families', () => {
  assert.equal(toolKindForName('bash'), 'execute')
  assert.equal(toolKindForName('ssh_exec'), 'execute')
  assert.equal(toolKindForName('ssh_upload'), 'execute')
  assert.equal(toolKindForName('read'), 'read')
  assert.equal(toolKindForName('write'), 'edit')
  assert.equal(toolKindForName('edit'), 'edit')
  assert.equal(toolKindForName('glob'), 'search')
  assert.equal(toolKindForName('grep'), 'search')
  assert.equal(toolKindForName('web_search'), 'search')
  assert.equal(toolKindForName('subagent'), 'think')
  assert.equal(toolKindForName('subagent_fork'), 'think')
  assert.equal(toolKindForName('send_message'), 'think')
  assert.equal(toolKindForName('todo_write'), 'other')
  assert.equal(toolKindForName('workflow'), 'other')
})

test('todoToPlanEntries fixes priority to medium and passes status through', () => {
  const entries = todoToPlanEntries([
    { content: 'a', status: 'pending' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'completed' },
  ])
  assert.deepEqual(entries, [
    { content: 'a', priority: 'medium', status: 'pending' },
    { content: 'b', priority: 'medium', status: 'in_progress' },
    { content: 'c', priority: 'medium', status: 'completed' },
  ])
})

test('acpPromptToText concatenates text and renders resource links', () => {
  const text = acpPromptToText([
    { type: 'text', text: 'read ' },
    { type: 'resource_link', name: 'src', uri: 'file:///tmp/x' },
  ])
  assert.ok(text.includes('read '))
  assert.ok(text.includes('file:///tmp/x'))
})

test('promptHasUnsupportedContent accepts baseline and rejects richer blocks', () => {
  assert.equal(promptHasUnsupportedContent([{ type: 'text', text: 'hi' }]), false)
  assert.equal(promptHasUnsupportedContent([{ type: 'image', data: 'AAAA' }]), true)
})

test('parseToolArguments parses JSON and preserves malformed input', () => {
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 })
  assert.equal(parseToolArguments('{not json'), '{not json')
})

test('toolResultToText renders text output and errors', () => {
  assert.equal(toolResultToText([{ type: 'text', text: 'out' }]), 'out')
  assert.equal(toolResultToText([{ type: 'text', text: 'out' }], { name: 'boom', code: 'E_X' }), '[tool error E_X] boom')
  assert.equal(toolResultToText([]), '(no text output)')
})

test('toolResultToText unwraps tool-result blocks', () => {
  assert.equal(
    toolResultToText([{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: 'denied' }] }]),
    'denied',
  )
})

test('encodeModelOption qualifies a model id with its provider', () => {
  assert.equal(encodeModelOption('opencode-go', 'deepseek-v4-flash'), 'opencode-go:deepseek-v4-flash')
  assert.equal(encodeModelOption('deepseek-official', 'deepseek-v4-flash'), 'deepseek-official:deepseek-v4-flash')
})

test('parseModelOption splits provider-qualified values and rejects bare ids', () => {
  assert.deepEqual(parseModelOption('opencode-go:deepseek-v4-flash'), { provider: 'opencode-go', model: 'deepseek-v4-flash' })
  assert.equal(parseModelOption('deepseek-v4-flash'), undefined)
  assert.equal(parseModelOption(':model'), undefined)
  assert.equal(parseModelOption('provider:'), undefined)
  // a model id containing a separator still splits at the first one
  assert.deepEqual(parseModelOption('p:a:b'), { provider: 'p', model: 'a:b' })
})
