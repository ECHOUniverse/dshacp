// Pure codec unit tests — no model, no process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acpPromptToText,
  callTimeDiffsForTool,
  encodeModelOption,
  fileDiffsToAcpContent,
  imageExtensionForMime,
  locationsFromDiffs,
  parseDiffsFromMeta,
  parseModelOption,
  parseToolArguments,
  promptHasUnsupportedContent,
  resolveToolPath,
  resultDiffsForTool,
  todoToPlanEntries,
  toolKindForName,
  toolResultToText,
  toolTitleForCall,
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

test('promptHasUnsupportedContent accepts baseline and image, rejects audio/resource (P5)', () => {
  assert.equal(promptHasUnsupportedContent([{ type: 'text', text: 'hi' }]), false)
  assert.equal(promptHasUnsupportedContent([{ type: 'resource_link', name: 'n', uri: 'file:///x' }]), false)
  assert.equal(promptHasUnsupportedContent([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]), false)
  assert.equal(promptHasUnsupportedContent([{ type: 'audio', data: 'AAAA' }]), true)
  assert.equal(promptHasUnsupportedContent([{ type: 'resource', name: 'n', uri: 'file:///x' }]), true)
})

test('imageExtensionForMime maps the P5 whitelist and rejects everything else', () => {
  assert.equal(imageExtensionForMime('image/png'), '.png')
  assert.equal(imageExtensionForMime('image/jpeg'), '.jpg')
  assert.equal(imageExtensionForMime('image/jpg'), '.jpg')
  assert.equal(imageExtensionForMime('image/webp'), '.webp')
  assert.equal(imageExtensionForMime('image/gif'), '.gif')
  // case and surrounding whitespace are tolerated
  assert.equal(imageExtensionForMime('  IMAGE/PNG  '), '.png')
  assert.equal(imageExtensionForMime('image/svg+xml'), undefined)
  assert.equal(imageExtensionForMime('image/tiff'), undefined)
  assert.equal(imageExtensionForMime(''), undefined)
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

test('resolveToolPath absolutizes relative paths against cwd', () => {
  assert.equal(resolveToolPath('/abs/foo.ts', '/proj'), '/abs/foo.ts')
  assert.equal(resolveToolPath('docs/foo.md', '/proj'), '/proj/docs/foo.md')
  assert.equal(resolveToolPath('rel.txt', ''), 'rel.txt')
})

test('callTimeDiffsForTool maps write/edit call args to preview diffs', () => {
  assert.deepEqual(
    callTimeDiffsForTool('write', { file_path: 'a.ts', content: 'hello' }),
    [{ path: 'a.ts', oldText: null, newText: 'hello' }],
  )
  assert.deepEqual(
    callTimeDiffsForTool('edit', { file_path: 'b.ts', old_string: 'x', new_string: 'y' }),
    [{ path: 'b.ts', oldText: 'x', newText: 'y' }],
  )
  assert.equal(callTimeDiffsForTool('bash', { command: 'ls' }), undefined)
})

test('parseDiffsFromMeta validates meta.diffs and rejects malformed data', () => {
  const valid = { diffs: [{ path: 'a.ts', oldText: 'a', newText: 'b' }] }
  assert.deepEqual(parseDiffsFromMeta(valid), valid.diffs)
  assert.equal(parseDiffsFromMeta({ diffs: [] }), undefined)
  assert.equal(parseDiffsFromMeta({ diffs: [{ path: 1, oldText: null, newText: 'x' }] }), undefined)
  assert.equal(parseDiffsFromMeta(null), undefined)
})

test('resultDiffsForTool prefers meta hunks and write falls back to args', () => {
  const meta = { diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] }
  assert.deepEqual(
    resultDiffsForTool('edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }, meta),
    meta.diffs,
  )
  assert.deepEqual(
    resultDiffsForTool('write', { file_path: 'new.ts', content: 'body' }, { diffs: [] }),
    [{ path: 'new.ts', oldText: null, newText: 'body' }],
  )
  assert.equal(
    resultDiffsForTool('edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }, undefined),
    undefined,
  )
})

test('fileDiffsToAcpContent and locationsFromDiffs emit absolute ACP shapes', () => {
  const diffs = [{ path: 'src/foo.ts', oldText: null, newText: 'hi' }]
  const cwd = '/project'
  assert.deepEqual(fileDiffsToAcpContent(diffs, cwd), [{
    type: 'diff',
    path: '/project/src/foo.ts',
    oldText: null,
    newText: 'hi',
  }])
  assert.deepEqual(locationsFromDiffs(diffs, cwd), [{ path: '/project/src/foo.ts' }])
})

test('write/edit titles include the file path', () => {
  assert.equal(toolTitleForCall('write', { file_path: 'docs/a.md', content: 'x' }), 'Write docs/a.md')
  assert.equal(toolTitleForCall('edit', { file_path: 'src/b.ts', old_string: 'a', new_string: 'b' }), 'Edit src/b.ts')
  assert.equal(toolTitleForCall('write', {}), 'write')
})
