// Phase 4 e2e tests: config options (model/thinking/mode), slash commands,
// MCP forwarding, and elicitation over the built bin (SDK client over stdio,
// like Zed). Prompt tests need a real model credential and skip without one.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECT_ROOT, TEST_HOME, TEST_SESSIONS, hasModelCredential, makeTestHome, spawnBridge, waitFor } from './harness.mjs'

// (TEST_HOME comes from the harness; one directory per test-process pid)
const PROMPT_AVAILABLE = hasModelCredential()
console.error(`[dshacp p4 e2e] model credential ${PROMPT_AVAILABLE ? 'available' : 'NOT available (prompt tests skipped)'}`)

const FIXTURE_MCP = fileURLToPath(new URL('./mcp-fixture-server.mjs', import.meta.url))

let bridge

/**
 * Spawn and initialize a fresh bridge.
 * @param options - spawnBridge options; `advertiseElicitation: false` leaves
 *   the client capability out (the bridge then fails ask_user_question closed).
 */
async function initBridge(options = {}) {
  const { advertiseElicitation = true } = options
  const spawned = spawnBridge(options)
  await waitFor(async () => {
    try {
      await spawned.client.initialize({
        protocolVersion: 1,
        clientCapabilities: advertiseElicitation ? { elicitation: { form: {} } } : {},
        clientInfo: { name: 'dshacp-p4-test', version: '0.0.1' },
      })
      return true
    } catch {
      return false
    }
  }, 60000)
  return spawned
}

before(async () => {
  await rm(TEST_SESSIONS, { recursive: true, force: true })
  makeTestHome()
  bridge = await initBridge()
})

after(async () => {
  await bridge?.stop()
  await rm(TEST_SESSIONS, { recursive: true, force: true })
})

test('initialize advertises http MCP capability (P4b)', async () => {
  const spawned = await initBridge()
  try {
    const init = await spawned.client.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'dshacp-p4-test', version: '0.0.1' },
    })
    assert.equal(init.agentCapabilities.mcpCapabilities.http, true,
      'http MCP forwarding is advertised')
    assert.notEqual(init.agentCapabilities.mcpCapabilities.acp, true,
      'acp transport is not advertised')
  } finally {
    await spawned.stop()
  }
})

test('session/new returns model/thinking/mode config options (DESIGN D3/D7)', async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  const options = created.configOptions
  assert.ok(Array.isArray(options) && options.length >= 3, 'configOptions present')

  const model = options.find(option => option.id === 'model')
  assert.ok(model, 'model option present')
  assert.equal(model.type, 'select')
  assert.equal(model.category, 'model')
  assert.equal(typeof model.currentValue, 'string')
  assert.ok(model.options.length > 0, 'model options non-empty')
  assert.ok(model.options.some(option => option.value === model.currentValue),
    'current model is one of the offered models')
  // Option values are provider-qualified so identical model ids on different
  // providers stay distinct in the client picker (and the current value
  // highlights exactly one option).
  const modelValues = model.options.flatMap(option =>
    'group' in option ? option.options.map(item => item.value) : [option.value])
  assert.ok(modelValues.every(value => value.includes(':')),
    'model option values are provider-qualified')
  assert.equal(modelValues.filter(value => value === model.currentValue).length, 1,
    'current value highlights exactly one model option')

  const thinking = options.find(option => option.id === 'thought_level')
  assert.ok(thinking, 'thinking option present for a reasoning-capable model')
  assert.equal(thinking.type, 'select')
  assert.equal(thinking.category, 'thought_level')
  assert.ok(thinking.options.length > 0, 'efforts non-empty')
  assert.ok(thinking.options.some(option => option.value === thinking.currentValue),
    'current effort is one of the offered efforts')

  const mode = options.find(option => option.id === 'mode')
  assert.ok(mode, 'mode option present')
  assert.equal(mode.type, 'select')
  assert.equal(mode.category, 'mode')
  assert.equal(mode.currentValue, 'standard', 'session starts in the default preset')
  assert.ok(mode.options.some(option => option.value === 'standard'), 'standard is offered')
  assert.ok(mode.options.some(option => option.value === 'minimal'), 'minimal is offered')
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('set_config_option switches the model and resets thinking to its default (D8)', async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  const before = created.configOptions.find(option => option.id === 'model')
  const target = before.options.find(option => option.value !== before.currentValue)
  assert.ok(target, 'a second model is offered')
  const after = await bridge.client.setSessionConfigOption({
    sessionId: created.sessionId,
    configId: 'model',
    value: target.value,
  })
  const modelAfter = after.configOptions.find(option => option.id === 'model')
  assert.equal(modelAfter.currentValue, target.value, 'model switched')
  // Thinking must still be a valid offered effort of the new model.
  const thinkingAfter = after.configOptions.find(option => option.id === 'thought_level')
  assert.ok(thinkingAfter, 'thinking option survives the switch')
  assert.ok(thinkingAfter.options.some(option => option.value === thinkingAfter.currentValue),
    'thinking reset to an offered effort of the new model')
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('set_config_option validates unknown models and efforts', async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  await assert.rejects(
    bridge.client.setSessionConfigOption({ sessionId: created.sessionId, configId: 'model', value: 'no-such-model' }),
    (error) => error.code === -32602,
  )
  await assert.rejects(
    bridge.client.setSessionConfigOption({ sessionId: created.sessionId, configId: 'thought_level', value: 'ludicrous' }),
    (error) => error.code === -32602,
  )
  await assert.rejects(
    bridge.client.setSessionConfigOption({ sessionId: created.sessionId, configId: 'unknown_option', value: 'x' }),
    (error) => error.code === -32602,
  )
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('model config option accepts provider-qualified and bare ids', async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  // Provider-qualified value (what the picker sends).
  const qualified = await bridge.client.setSessionConfigOption({
    sessionId: created.sessionId,
    configId: 'model',
    value: 'deepseek-official:deepseek-v4-pro',
  })
  assert.equal(qualified.configOptions.find(option => option.id === 'model').currentValue,
    'deepseek-official:deepseek-v4-pro')
  // Bare id (a legacy default_config_options entry) resolves to the single
  // owning provider.
  const bare = await bridge.client.setSessionConfigOption({
    sessionId: created.sessionId,
    configId: 'model',
    value: 'deepseek-v4-flash',
  })
  assert.equal(bare.configOptions.find(option => option.id === 'model').currentValue,
    'deepseek-official:deepseek-v4-flash')
  // A qualified value naming an unknown provider is rejected.
  await assert.rejects(
    bridge.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'model',
      value: 'no-such-provider:deepseek-v4-pro',
    }),
    (error) => error.code === -32602,
  )
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('model/thinking switches are remembered as the default for fresh sessions', async () => {
  // Isolated home so the shared harness home (and the machine's real ~/.dsh)
  // is never mutated by this test.
  const home = join(PROJECT_ROOT, `.test-home-persist-${process.pid}`)
  await rm(home, { recursive: true, force: true })
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'settings.yaml'), [
    'permission:',
    '  defaultPreset: workspace-write',
    'agent-default-model:',
    '  provider: deepseek-official',
    '  model: deepseek-v4-flash',
    '',
  ].join('\n'), 'utf8')
  const spawned = spawnBridge({ env: { DSH_HOME: home } })
  try {
    await waitFor(async () => {
      try {
        await spawned.client.initialize({
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'dshacp-p4-test', version: '0.0.1' },
        })
        return true
      } catch {
        return false
      }
    }, 60000)

    // Session A: pick a model + thinking combination.
    const a = await spawned.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
    await spawned.client.setSessionConfigOption({ sessionId: a.sessionId, configId: 'model', value: 'deepseek-official:deepseek-v4-pro' })
    await spawned.client.setSessionConfigOption({ sessionId: a.sessionId, configId: 'thought_level', value: 'off' })
    await spawned.client.closeSession({ sessionId: a.sessionId })

    // Session B (fresh): starts from the remembered combination.
    const b = await spawned.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
    const modelB = b.configOptions.find(option => option.id === 'model')
    const thinkB = b.configOptions.find(option => option.id === 'thought_level')
    assert.equal(modelB.currentValue, 'deepseek-official:deepseek-v4-pro', 'fresh session starts on the remembered model')
    assert.equal(thinkB.currentValue, 'off', 'fresh session starts on the remembered thinking')
    await spawned.client.closeSession({ sessionId: b.sessionId })

    // The settings document on disk carries the combination.
    const settings = await readFile(join(home, 'settings.yaml'), 'utf8')
    assert.match(settings, /provider: deepseek-official/, 'provider persisted')
    assert.match(settings, /model: deepseek-v4-pro/, 'model persisted')
    assert.match(settings, /reasoningEffort: off/, 'thinking persisted')
  } finally {
    await spawned.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('mode switches only a blank session; a started session soft-rejects (D9)', async () => {
  // Blank session: recompose to minimal.
  const blank = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  const switched = await bridge.client.setSessionConfigOption({
    sessionId: blank.sessionId,
    configId: 'mode',
    value: 'minimal',
  })
  assert.equal(switched.configOptions.find(option => option.id === 'mode').currentValue, 'minimal')
  await bridge.client.closeSession({ sessionId: blank.sessionId })

  // Started session: soft-reject — unchanged value, no exception.
  const started = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  await bridge.client.prompt({
    sessionId: started.sessionId,
    prompt: [{ type: 'text', text: 'Say hi.' }],
  })
  const refused = await bridge.client.setSessionConfigOption({
    sessionId: started.sessionId,
    configId: 'mode',
    value: 'minimal',
  })
  assert.equal(refused.configOptions.find(option => option.id === 'mode').currentValue, 'standard',
    'a started session keeps its mode')
  await bridge.client.closeSession({ sessionId: started.sessionId })
})

test('every shipped mode is selectable on a blank session (cordis needs the host runner)', async () => {
  for (const mode of ['code', 'minimal', 'cordis']) {
    const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
    const switched = await bridge.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'mode',
      value: mode,
    })
    assert.equal(switched.configOptions.find(option => option.id === 'mode').currentValue, mode,
      `mode "${mode}" switches`)
    await bridge.client.closeSession({ sessionId: created.sessionId })
  }
})

test('session creation pushes available_commands_update over userInvocable skills (D10)', async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  const update = await waitFor(() => bridge.updates.find(update =>
    update.kind === 'session_update' && update.tag === 'available_commands_update'
    && update.sessionId === created.sessionId))
  assert.ok(Array.isArray(update.update.availableCommands), 'commands array present')
  for (const command of update.update.availableCommands) {
    assert.equal(typeof command.name, 'string')
    assert.equal(typeof command.description, 'string')
  }
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('ask_user_question elicits through the client (P4b-4)', { skip: !PROMPT_AVAILABLE }, async () => {
  const spawned = await initBridge({
    handlers: {
      unstable_createElicitation: async (params) => {
        // Answer the first question with the first offered option label.
        const property = params.requestedSchema?.properties?.['q0']
        const labels = property?.enum ?? []
        return { action: 'accept', content: { q0: labels[0] ?? 'yes' } }
      },
    },
  })
  try {
    const created = await spawned.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
    const result = await spawned.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'Use the ask_user_question tool to ask the user: continue? with options yes and no. Then report what the user chose.' }],
    })
    assert.ok(['end_turn', 'max_tokens'].includes(result.stopReason), `prompt settled: ${result.stopReason}`)
    const request = await waitFor(() => spawned.updates.find(update => update.kind === 'elicitation'))
    assert.equal(request.params.mode, 'form')
    assert.equal(request.params.sessionId, created.sessionId)
    assert.equal(request.params.requestedSchema.type, 'object')
    assert.ok(request.params.requestedSchema.properties.q0, 'question mapped to a form property')
    assert.match(request.params.message, /continue/i, 'message carries the question')
    // The model must have seen the answer (the tool result feeds the loop).
    const message = await waitFor(() => {
      const byMessage = new Map()
      for (const update of spawned.updates) {
        if (update.kind !== 'session_update' || update.tag !== 'agent_message_chunk') continue
        const id = update.update.messageId ?? 'default'
        byMessage.set(id, (byMessage.get(id) ?? '') + update.update.content.text)
      }
      const text = [...byMessage.values()].join(' ')
      return /yes|no/i.test(text) ? true : undefined
    })
    assert.ok(message, 'the answer reached the model')
    await spawned.client.closeSession({ sessionId: created.sessionId })
  } finally {
    await spawned.stop()
  }
})

test('a client without elicitation gets a closed ask_user_question failure', { skip: !PROMPT_AVAILABLE }, async () => {
  // The shared bridge advertised elicitation, so spawn one that did not.
  const spawned = await initBridge({ advertiseElicitation: false })
  try {
    const created = await spawned.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
    const result = await spawned.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'Use the ask_user_question tool to ask the user: continue? Report what happened.' }],
    })
    assert.ok(['end_turn', 'max_tokens'].includes(result.stopReason), `prompt settled: ${result.stopReason}`)
    const call = await waitFor(() => spawned.updates.find(update =>
      update.kind === 'session_update' && update.tag === 'tool_call'
      && update.update.title === 'ask_user_question'))
    const settled = await waitFor(() => spawned.updates.find(update =>
      update.kind === 'session_update' && update.tag === 'tool_call_update'
      && update.update.toolCallId === call.update.toolCallId))
    assert.match(String(settled.update.rawOutput), /CLIENT_UNSUPPORTED|elicitation|unavailable/i,
      'the tool failed closed with an elicitation diagnostic')
    await spawned.client.closeSession({ sessionId: created.sessionId })
  } finally {
    await spawned.stop()
  }
})

test('MCP forwarding mounts a stdio server whose tools the model can call (D12)', { skip: !PROMPT_AVAILABLE }, async () => {
  const spawned = await initBridge()
  try {
    const created = await spawned.client.newSession({
      cwd: PROJECT_ROOT,
      mcpServers: [{ name: 'fixture', command: 'node', args: [FIXTURE_MCP], env: [] }],
    })
    const result = await spawned.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'Call the mcp__fixture__fixture_echo tool with message "hello-from-mcp" and report the tool result verbatim.' }],
    })
    assert.ok(['end_turn', 'max_tokens'].includes(result.stopReason), `prompt settled: ${result.stopReason}`)
    const call = await waitFor(() => spawned.updates.find(update =>
      update.kind === 'session_update' && update.tag === 'tool_call'
      && update.update.title === 'mcp__fixture__fixture_echo'))
    assert.ok(call, 'the forwarded tool was called by the model')
    const settled = await waitFor(() => spawned.updates.find(update =>
      update.kind === 'session_update' && update.tag === 'tool_call_update'
      && update.update.toolCallId === call.update.toolCallId))
    assert.match(String(settled.update.rawOutput), /fixture echoed: hello-from-mcp/,
      'the MCP result reached the model')
    await spawned.client.closeSession({ sessionId: created.sessionId })
  } finally {
    await spawned.stop()
  }
})

test('MCP forwarding skips unsupported transports and never fails the session', async () => {
  const spawned = await initBridge()
  try {
    const created = await spawned.client.newSession({
      cwd: PROJECT_ROOT,
      mcpServers: [
        { name: 'remote-sse', type: 'sse', url: 'http://127.0.0.1:9/sse', headers: [] },
        { name: 'remote-acp', type: 'acp', id: 'acp-1' },
        { name: 'broken-stdio', command: 'no-such-binary-xyz', args: [], env: [] },
      ],
    })
    assert.ok(created.sessionId, 'session created despite unsupported/broken servers')
    const listed = await spawned.client.listSessions({})
    assert.ok(listed.sessions.some(session => session.sessionId === created.sessionId))
    await spawned.client.closeSession({ sessionId: created.sessionId })
  } finally {
    await spawned.stop()
  }
})

test('session/load and resume return config options', { skip: !PROMPT_AVAILABLE }, async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  await bridge.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'Say hi.' }] })
  await bridge.client.closeSession({ sessionId: created.sessionId })

  const loaded = await bridge.client.loadSession({ sessionId: created.sessionId, cwd: PROJECT_ROOT, mcpServers: [] })
  assert.ok(loaded.configOptions.some(option => option.id === 'mode'), 'load returns config options')
  await bridge.client.closeSession({ sessionId: created.sessionId })

  const resumed = await bridge.client.resumeSession({ sessionId: created.sessionId, cwd: PROJECT_ROOT })
  assert.ok(resumed.configOptions.some(option => option.id === 'model'), 'resume returns config options')
  await bridge.client.closeSession({ sessionId: created.sessionId })
  await bridge.client.deleteSession({ sessionId: created.sessionId })
})

test('set_config_option responds with the complete option list', async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  const after = await bridge.client.setSessionConfigOption({
    sessionId: created.sessionId,
    configId: 'thought_level',
    value: 'off',
  })
  assert.equal(after.configOptions.find(option => option.id === 'thought_level').currentValue, 'off')
  assert.ok(after.configOptions.find(option => option.id === 'model'), 'model present in the full list')
  assert.ok(after.configOptions.find(option => option.id === 'mode'), 'mode present in the full list')
  await bridge.client.closeSession({ sessionId: created.sessionId })
})
