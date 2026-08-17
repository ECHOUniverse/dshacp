// Unit tests for `toolTitleForCall` — execute-tool card titles show the
// command content, everything else keeps the tool name (see docs/execute-tool-card-title-fix.md §7).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolTitleForCall } from '../lib/codec.js'

test('bash tool uses the command argument as title', () => {
  assert.equal(toolTitleForCall('bash', { command: 'git status' }), 'git status')
})

test('bash falls back to the tool name for a blank command', () => {
  assert.equal(toolTitleForCall('bash', { command: '   ' }), 'bash')
})

test('bash falls back to the tool name when command is missing', () => {
  assert.equal(toolTitleForCall('bash', { timeoutMs: 1000 }), 'bash')
})

test('bash falls back to the tool name when arguments are not an object', () => {
  assert.equal(toolTitleForCall('bash', 'not-an-object'), 'bash')
})

test('bash falls back to the tool name when arguments are null', () => {
  assert.equal(toolTitleForCall('bash', null), 'bash')
})

test('terminal is treated like bash', () => {
  assert.equal(toolTitleForCall('terminal', { command: 'make build' }), 'make build')
})

test('ssh_* family reads the cmd key', () => {
  assert.equal(toolTitleForCall('ssh_remote', { cmd: 'uptime' }), 'uptime')
})

test('overlong commands are truncated to 80 chars with an ellipsis', () => {
  const long = 'a'.repeat(81)
  assert.equal(toolTitleForCall('bash', { command: long }), `${'a'.repeat(80)}…`)
  // exactly 80 chars is left untouched
  assert.equal(toolTitleForCall('bash', { command: 'a'.repeat(80) }), 'a'.repeat(80))
})

test('non-execute tools keep the tool name', () => {
  assert.equal(toolTitleForCall('read', { path: '/x' }), 'read')
})

test('unknown tools keep the tool name', () => {
  assert.equal(toolTitleForCall('bogus', {}), 'bogus')
})

test('tool name matching is case-insensitive', () => {
  assert.equal(toolTitleForCall('Bash', { command: 'echo' }), 'echo')
})
