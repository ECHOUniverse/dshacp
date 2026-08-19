// Unit tests for subagent delegation card helpers in codec.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSubagentDelegationTool,
  parseSubagentLaunch,
  subagentCardText,
  subagentNotificationSource,
  toolTitleForCall,
} from '../lib/codec.js'

test('isSubagentDelegationTool recognizes provider-bound delegation tools', () => {
  assert.equal(isSubagentDelegationTool('subagent'), true)
  assert.equal(isSubagentDelegationTool('subagent_fork'), true)
  assert.equal(isSubagentDelegationTool('Subagent'), true)
  assert.equal(isSubagentDelegationTool('send_message'), false)
})

test('toolTitleForCall uses description for subagent delegation tools', () => {
  assert.equal(
    toolTitleForCall('subagent', { description: 'research query', prompt: 'x' }),
    'Subagent: research query',
  )
  assert.equal(
    toolTitleForCall('subagent_fork', { description: 'fork task' }),
    'Subagent fork: fork task',
  )
  assert.equal(toolTitleForCall('subagent', { prompt: 'only prompt' }), 'subagent')
})

test('toolTitleForCall formats send_message and ralph targets', () => {
  assert.equal(toolTitleForCall('send_message', { subagent_id: 'child-1', message: 'hi' }), 'Send to child-1')
  assert.equal(toolTitleForCall('ralph', { description: 'loop' }), 'Ralph: loop')
})

test('parseSubagentLaunch recognizes canonical launch confirmations', () => {
  assert.deepEqual(parseSubagentLaunch('started subagent sess_child_1'), {
    kind: 'continuable',
    id: 'sess_child_1',
  })
  assert.deepEqual(parseSubagentLaunch('started background subagent job job_42'), {
    kind: 'background',
    id: 'job_42',
  })
  assert.equal(parseSubagentLaunch('ok'), undefined)
})

test('subagentCardText builds call and lifecycle bodies', () => {
  const args = { description: 'regression-test', prompt: 'Reply ok', run_in_background: false }
  assert.match(subagentCardText({ toolName: 'subagent', args, phase: 'call' }), /Task: regression-test/)
  assert.match(subagentCardText({ toolName: 'subagent', args, phase: 'call' }), /Mode: foreground/)
  assert.match(
    subagentCardText({ toolName: 'subagent', args, phase: 'running', childId: 'child-1' }),
    /Status: running/,
  )
  assert.match(
    subagentCardText({
      toolName: 'subagent',
      args,
      phase: 'launched',
      childId: 'child-1',
      resultText: 'started subagent child-1',
    }),
    /started in background/,
  )
})

test('subagentNotificationSource detects report and settlement injections', () => {
  assert.deepEqual(
    subagentNotificationSource({ kind: 'subagent-report', senderSessionId: 'child-1' }),
    { kind: 'report', senderSessionId: 'child-1' },
  )
  assert.deepEqual(
    subagentNotificationSource({ kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-2' }),
    { kind: 'settled', senderSessionId: 'child-2' },
  )
  assert.equal(subagentNotificationSource({ kind: 'user' }), undefined)
})
