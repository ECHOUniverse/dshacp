// Unit tests for session preset resolution (resolveRecordedPreset).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRecordedPreset } from '../lib/preset.js'

/** Minimal session stand-in: header + snapshotEvents only. */
function sessionOf(header, events) {
  return {
    header,
    snapshotEvents: () => events,
  }
}

test('resolveRecordedPreset returns header.agentPreset when no selection events exist', () => {
  const session = sessionOf({ agentPreset: 'standard' }, [])
  assert.equal(resolveRecordedPreset(session), 'standard')
})

test('resolveRecordedPreset returns undefined when header omits agentPreset', () => {
  const session = sessionOf({}, [])
  assert.equal(resolveRecordedPreset(session), undefined)
})

test('resolveRecordedPreset prefers the last agent-preset/selected event', () => {
  const session = sessionOf(
    { agentPreset: 'standard' },
    [
      { type: 'agent-preset/selected', data: { agentPreset: 'cordis' } },
      { type: 'turn/start', data: {} },
      { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } },
    ],
  )
  assert.equal(resolveRecordedPreset(session), 'minimal')
})

test('resolveRecordedPreset ignores selection events before the final one in wire order', () => {
  const session = sessionOf(
    { agentPreset: 'standard' },
    [
      { type: 'agent-preset/selected', data: { agentPreset: 'cordis' } },
      { type: 'agent-preset/selected', data: { agentPreset: 'code' } },
    ],
  )
  assert.equal(resolveRecordedPreset(session), 'code')
})
