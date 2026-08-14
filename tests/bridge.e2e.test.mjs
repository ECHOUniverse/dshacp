// End-to-end protocol tests against the built bin (like Zed: SDK client over
// stdio). Prompt tests need a real model credential and skip without one.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT, hasModelCredential, spawnBridge, waitFor } from './harness.mjs'

const SESSIONS = `${PROJECT_ROOT}/.test-sessions`
const PROMPT_AVAILABLE = await hasModelCredential()
console.error(`[dshacp e2e] model credential ${PROMPT_AVAILABLE ? 'available' : 'NOT available (prompt tests skipped)'}`)

let bridge

before(async () => {
  await rm(SESSIONS, { recursive: true, force: true })
  bridge = spawnBridge()
  // Give the tree time to boot; initialize retries until it answers.
  await waitFor(async () => {
    try {
      await bridge.client.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: 'dshacp-test', version: '0.0.1' },
      })
      return true
    } catch {
      return false
    }
  }, 60000)
})

after(async () => {
  await bridge?.stop()
  await rm(SESSIONS, { recursive: true, force: true })
  await rm(join(homedir(), 'dshacp-approval-probe'), { force: true })
})

test('initialize negotiates the DESIGN §5 surface', async () => {
  const init = await bridge.client.initialize({
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'dshacp-test', version: '0.0.1' },
  })
  assert.equal(init.protocolVersion, 1)
  assert.equal(init.agentCapabilities.loadSession, true)
  assert.deepEqual(init.agentCapabilities.promptCapabilities, {})
  assert.ok(init.agentCapabilities.sessionCapabilities.list)
  assert.ok(init.agentCapabilities.sessionCapabilities.resume)
  assert.ok(init.agentCapabilities.sessionCapabilities.close)
  assert.ok(init.agentCapabilities.sessionCapabilities.delete)
  assert.deepEqual(init.authMethods, [])
})

test('session/new creates a session listed by session/list', async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  assert.ok(created.sessionId)
  const listed = await bridge.client.listSessions({})
  assert.ok(listed.sessions.some(session => session.sessionId === created.sessionId))
  assert.equal(listed.sessions.find(session => session.sessionId === created.sessionId).cwd, PROJECT_ROOT)
})

test('session/new rejects a relative cwd', async () => {
  await assert.rejects(
    bridge.client.newSession({ cwd: 'relative/path', mcpServers: [] }),
    (error) => error.code === -32602,
  )
})

test('session/prompt rejects unsupported content blocks', async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  await assert.rejects(
    bridge.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'image', data: 'AAAA' }] }),
    (error) => error.code === -32602,
  )
})

test('session/close frees the session; close of an unknown session errors', async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  await bridge.client.closeSession({ sessionId: created.sessionId })
  await assert.rejects(
    bridge.client.closeSession({ sessionId: created.sessionId }),
    (error) => error.code === -32602,
  )
})

test('session/delete removes the session from the list', { skip: !PROMPT_AVAILABLE }, async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  await bridge.client.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'Say hi.' }],
  })
  await bridge.client.closeSession({ sessionId: created.sessionId })
  // A prompted session is durable, so it must be listed after close.
  let listed = await bridge.client.listSessions({})
  assert.ok(listed.sessions.some(session => session.sessionId === created.sessionId),
    'prompted session is listed after close')
  await bridge.client.deleteSession({ sessionId: created.sessionId })
  listed = await bridge.client.listSessions({})
  assert.ok(!listed.sessions.some(session => session.sessionId === created.sessionId),
    'deleted session is gone from the list')
})

test('session/cancel with no prompt is a no-op', async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  await bridge.client.cancel({ sessionId: created.sessionId })
  const listed = await bridge.client.listSessions({})
  assert.ok(listed.sessions.some(session => session.sessionId === created.sessionId))
})

test('session/load replays history after a prompt', { skip: !PROMPT_AVAILABLE }, async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  const result = await bridge.client.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'Reply with exactly: hello world' }],
  })
  assert.equal(result.stopReason, 'end_turn')
  // Live stream: message chunks with a stable messageId, then usage.
  const message = await waitFor(() => bridge.updates.find(update =>
    update.kind === 'session_update' && update.tag === 'agent_message_chunk'
    && typeof update.update.content.text === 'string' && update.update.content.text.length > 0))
  assert.ok(message.update.messageId, 'agent_message_chunk carries a messageId')
  assert.ok(message.update.content.text.length > 0)
  const usageSeen = bridge.updates.some(update =>
    update.kind === 'session_update' && update.tag === 'usage_update')
  assert.ok(usageSeen, 'usage_update emitted after a real turn')
  await bridge.client.closeSession({ sessionId: created.sessionId })

  // Load into a fresh thread: full replay, including the user prompt and the
  // assistant answer, then null response.
  const replayStart = bridge.updates.length
  await bridge.client.loadSession({ sessionId: created.sessionId, cwd: PROJECT_ROOT, mcpServers: [] })
  const replayed = bridge.updates.slice(replayStart)
  assert.ok(replayed.some(update =>
    update.kind === 'session_update' && update.tag === 'user_message_chunk'
    && update.update.content.text.includes('hello world')),
  'replay includes the user prompt')
  assert.ok(replayed.some(update =>
    update.kind === 'session_update' && update.tag === 'agent_message_chunk'),
  'replay includes the assistant answer')
  assert.ok(replayed.some(update =>
    update.kind === 'session_update' && update.tag === 'usage_update'),
  'replay includes cumulative usage')
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('session/cancel settles a running prompt with cancelled', { skip: !PROMPT_AVAILABLE }, async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  const prompt = bridge.client.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'List the numbers from 1 to 1000, one per line, no other text.' }],
  })
  // Give the turn a moment to start, then cancel.
  await new Promise((resolve) => setTimeout(resolve, 2500))
  await bridge.client.cancel({ sessionId: created.sessionId })
  const result = await prompt
  assert.equal(result.stopReason, 'cancelled')
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('session/resume continues a persisted conversation without replay', { skip: !PROMPT_AVAILABLE }, async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  const first = await bridge.client.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'Remember the secret word: zephyr. Reply: noted.' }],
  })
  assert.equal(first.stopReason, 'end_turn')
  await bridge.client.closeSession({ sessionId: created.sessionId })

  // Resume into a fresh thread: no history replay arrives, and the agent still
  // knows the secret word from its persisted session.
  const before = bridge.updates.length
  await bridge.client.resumeSession({ sessionId: created.sessionId, cwd: PROJECT_ROOT })
  const afterResume = bridge.updates.slice(before)
  assert.ok(!afterResume.some(update =>
    update.kind === 'session_update' && update.tag === 'user_message_chunk'),
  'resume sends no history replay')
  const second = await bridge.client.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'What was the secret word? Reply with only that word.' }],
  })
  assert.equal(second.stopReason, 'end_turn')
  // Token-level chunks split the word across chunks; join per messageId.
  const answer = await waitFor(() => {
    const byMessage = new Map()
    for (const update of bridge.updates.slice(before)) {
      if (update.kind !== 'session_update' || update.tag !== 'agent_message_chunk') continue
      const id = update.update.messageId ?? 'default'
      byMessage.set(id, (byMessage.get(id) ?? '') + update.update.content.text)
    }
    return [...byMessage.values()].some(text => text.toLowerCase().includes('zephyr')) ? true : undefined
  })
  assert.ok(answer, 'resumed agent remembers the conversation')
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('todo/write maps to plan updates with fixed medium priority', { skip: !PROMPT_AVAILABLE }, async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  const result = await bridge.client.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'Use todo_write to record exactly two steps: "step one" and "step two". Then say done.' }],
  })
  assert.ok(['end_turn', 'max_tokens'].includes(result.stopReason), `prompt settled: ${result.stopReason}`)
  const plan = await waitFor(() => bridge.updates.find(update =>
    update.kind === 'session_update' && update.tag === 'plan'
    && update.update.entries.some(entry => entry.content === 'step one')))
  assert.ok(plan.update.entries.every(entry => entry.priority === 'medium'),
    'plan entries carry fixed medium priority')
  assert.ok(plan.update.entries.some(entry => entry.content === 'step two'),
    'plan contains both steps')
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('approval bridge: a bash escalation surfaces as request_permission and allow-once grants it', { skip: !PROMPT_AVAILABLE }, async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  // Home-directory write → sandbox denial → model escalates with
  // sandbox_permissions → approval/request → bridge pushes request_permission.
  bridge.answerPermission({ outcome: 'selected', optionId: 'allow-once' })
  const result = await bridge.client.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'Run: touch ~/dshacp-approval-probe. If you hit a sandbox denial, retry the exact same command once with sandbox_permissions and a one-sentence justification, then confirm the file was created.' }],
  })
  assert.ok(['end_turn', 'max_tokens'].includes(result.stopReason), `prompt settled: ${result.stopReason}`)
  const permission = await waitFor(() => bridge.updates.find(update =>
    update.kind === 'request_permission' && update.params.sessionId === created.sessionId))
  assert.ok(permission.params.toolCall.toolCallId, 'permission request carries the tool call id')
  assert.deepEqual(
    permission.params.options.map(option => option.kind),
    ['allow_once', 'reject_once'],
    'permission offers allow_once + reject_once only',
  )
  // The tool must have completed (not failed) after the grant.
  const toolId = permission.params.toolCall.toolCallId
  const completed = await waitFor(() => bridge.updates.find(update =>
    update.kind === 'session_update' && update.tag === 'tool_call_update'
    && update.update.toolCallId === toolId && update.update.status === 'completed'))
  assert.ok(completed, 'granted tool call completed')
  const toolCalls = bridge.updates.filter(update =>
    update.kind === 'session_update' && update.tag === 'tool_call' && update.update.toolCallId === toolId)
  assert.equal(toolCalls[0].update.title, 'bash')
  assert.equal(toolCalls[0].update.kind, 'execute')
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('approval bridge: reject-once fails the tool closed', { skip: !PROMPT_AVAILABLE }, async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  bridge.answerPermission({ outcome: 'selected', optionId: 'reject-once' })
  const result = await bridge.client.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'Run: touch ~/dshacp-approval-probe. If you hit a sandbox denial, retry the exact same command once with sandbox_permissions and a one-sentence justification, then report what happened.' }],
  })
  assert.ok(['end_turn', 'max_tokens'].includes(result.stopReason), `prompt settled: ${result.stopReason}`)
  const permission = await waitFor(() => bridge.updates.find(update =>
    update.kind === 'request_permission' && update.params.sessionId === created.sessionId))
  const toolId = permission.params.toolCall.toolCallId
  // The DSH tool surfaces the rejection as a completed result whose text
  // reports the refusal (the approval is final — nothing wider ran).
  const settled = await waitFor(() => bridge.updates.find(update =>
    update.kind === 'session_update' && update.tag === 'tool_call_update'
    && update.update.toolCallId === toolId))
  assert.ok(settled.update.status === 'completed' || settled.update.status === 'failed',
    `rejected call settled as ${settled.update.status}`)
  assert.match(String(settled.update.rawOutput), /reject/i, 'rawOutput reports the rejection')
  await bridge.client.closeSession({ sessionId: created.sessionId })
})
