// End-to-end protocol tests against the built bin (like Zed: SDK client over
// stdio). Prompt tests need a real model credential and skip without one.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT, TEST_HOME, TEST_SESSIONS, hasModelCredential, makeTestHome, settledToolCall, spawnBridge, waitFor } from './harness.mjs'

const PROMPT_AVAILABLE = hasModelCredential()
console.error(`[dshacp e2e] model credential ${PROMPT_AVAILABLE ? 'available' : 'NOT available (prompt tests skipped)'}`)

let bridge

before(async () => {
  await rm(TEST_SESSIONS, { recursive: true, force: true })
  // Rebuild the harness home (the host machine's DSH_HOME settings must not
  // decide sandbox/approval behavior under test).
  makeTestHome()
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
  await rm(TEST_SESSIONS, { recursive: true, force: true })
  await rm(TEST_HOME, { recursive: true, force: true })
  await rm(join(homedir(), 'dshacp-approval-probe'), { force: true })
  await rm(join(homedir(), 'dshacp-allow-always-1'), { force: true })
  await rm(join(homedir(), 'dshacp-allow-always-2'), { force: true })
})

test('initialize negotiates the DESIGN §5 surface', async () => {
  const init = await bridge.client.initialize({
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'dshacp-test', version: '0.0.1' },
  })
  assert.equal(init.protocolVersion, 1)
  assert.equal(init.agentCapabilities.loadSession, true)
  // P5: the bridge advertises (and handles) image pasting.
  assert.deepEqual(init.agentCapabilities.promptCapabilities, { image: true })
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

test('session/prompt rejects audio and resource blocks (P5)', async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  await assert.rejects(
    bridge.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'audio', data: 'AAAA' }] }),
    (error) => error.code === -32602,
  )
  await assert.rejects(
    bridge.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'resource', name: 'n', uri: 'file:///x' }] }),
    (error) => error.code === -32602,
  )
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('session/prompt rejects pasted images outside the png/jpeg/webp/gif whitelist (P5)', async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  await assert.rejects(
    bridge.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'image', data: 'AAAA', mimeType: 'image/svg+xml' }] }),
    (error) => error.code === -32602 && /unsupported pasted image type: image\/svg\+xml/.test(error.message),
  )
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('session/prompt accepts image blocks, lands them in tmp, and replays the path markers (P5)', { skip: !PROMPT_AVAILABLE }, async () => {
  // Two distinguishable 1×1 PNGs (solid red / solid blue): identical bytes
  // would make the wire-order assertion below vacuous.
  const redPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
  const bluePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC'
  const expected = [redPng, bluePng]
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  const result = await bridge.client.prompt({
    sessionId: created.sessionId,
    prompt: [
      { type: 'text', text: 'Reply with exactly: ok' },
      { type: 'image', data: redPng, mimeType: 'image/png' },
      { type: 'image', data: bluePng, mimeType: 'image/png' },
    ],
  })
  assert.equal(result.stopReason, 'end_turn')
  await bridge.client.closeSession({ sessionId: created.sessionId })

  // Load into a fresh thread: the replay must carry one marker per image,
  // in wire order, each pointing at a real dshacp-*.png file in os.tmpdir()
  // whose bytes match the pasted image.
  const replayStart = bridge.updates.length
  await bridge.client.loadSession({ sessionId: created.sessionId, cwd: PROJECT_ROOT, mcpServers: [] })
  const userText = bridge.updates.slice(replayStart)
    .filter(update => update.kind === 'session_update' && update.tag === 'user_message_chunk')
    .map(update => update.update.content.text)
    .join('')
  const markers = [...userText.matchAll(/\[用户粘贴的图片: (\S+) — 如需理解图片内容，请调用 qwenmm 的 vision_chat \/ ocr 工具\]/g)]
  assert.equal(markers.length, 2, 'replay carries one pasted-image marker per image')
  const paths = [...new Set(markers.map(match => match[1]))]
  assert.equal(paths.length, 2, 'each image gets its own tmp path')
  // os.tmpdir() (e.g. /var/folders/.../T on macOS) is the documented landing
  // spot; assert against it rather than the /tmp symlink.
  const tmpPrefix = `${tmpdir()}/`
  try {
    for (const [index, match] of markers.entries()) {
      const path = match[1]
      assert.ok(path.startsWith(tmpPrefix), `marker points at the os tmpdir: ${path}`)
      assert.match(path.slice(tmpPrefix.length), /^dshacp-[0-9a-f-]+\.png$/, 'tmp file has the dshacp-<uuid>.png shape')
      const onDisk = await readFile(path)
      assert.deepEqual(onDisk, Buffer.from(expected[index], 'base64'),
        `tmp image ${index} matches the pasted image in wire order`)
    }
  } finally {
    for (const path of paths) await rm(path, { force: true })
  }
  await bridge.client.closeSession({ sessionId: created.sessionId })
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
  // The cumulative `used` is a real context-occupancy count: a finite,
  // non-negative number. Replay below must reproduce it exactly — a live
  // turn and its replayed log run through the same accumulateUsage path
  // (including the pi-ai reasoning-text estimate when the adapter reports
  // no reasoningTokens), so any divergence would mean the accounting is not
  // deterministic across load.
  const liveUsed = [...bridge.updates].reverse().find(update =>
    update.kind === 'session_update' && update.tag === 'usage_update')?.update.used
  assert.ok(Number.isFinite(liveUsed) && liveUsed >= 0,
    `live cumulative used is a finite non-negative count: ${liveUsed}`)
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
  const replayedUsed = [...replayed].reverse().find(update =>
    update.kind === 'session_update' && update.tag === 'usage_update')?.update.used
  assert.equal(replayedUsed, liveUsed,
    'replay reproduces the identical cumulative used (live == replay accounting)')
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

test('workflow runs render as tool_call cards, not plan updates (P2-1)', { skip: !PROMPT_AVAILABLE }, async () => {
  // Workflow runtime state belongs to the workflow tool call itself (kind
  // `other`), not the plan slot: the todo plan must survive a workflow run.
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  const start = bridge.updates.length
  const result = await bridge.client.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'Use the workflow tool to run exactly this script and report its result: meta name "wf-test", description "t". Body: phase("setup"); log("hello"); return "ok".' }],
  })
  assert.ok(['end_turn', 'max_tokens'].includes(result.stopReason), `prompt settled: ${result.stopReason}`)
  const run = await waitFor(() => {
    const call = bridge.updates.slice(start).find(update =>
      update.kind === 'session_update' && update.tag === 'tool_call'
      && update.update.title === 'workflow')
    if (call === undefined) return undefined
    // The first tool_call_update is the new in_progress transition; the
    // settling update is the one carrying the terminal status.
    const settled = bridge.updates.slice(start).find(update =>
      update.kind === 'session_update' && update.tag === 'tool_call_update'
      && update.update.toolCallId === call.update.toolCallId
      && update.update.status === 'completed')
    return settled !== undefined ? { call, settled } : undefined
  })
  assert.ok(run, 'workflow renders as a tool_call card that settles completed')
  assert.equal(run.call.update.kind, 'other', 'workflow card kind is `other`')
  assert.equal(run.settled.update.status, 'completed', 'workflow call settles completed')
  const plans = bridge.updates.slice(start).filter(update =>
    update.kind === 'session_update' && update.tag === 'plan')
  assert.equal(plans.length, 0, 'a workflow run produces no plan update')
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('a spawned subagent completes and its tool card settles clean (subagent fix)', { skip: !PROMPT_AVAILABLE }, async () => {
  // Regression for the subagent failure (docs/subagent-failure-fix.md): the
  // child assembles its system prompt from the parent's AgentOptions, so an
  // absent model made every child's first turn fail with
  // `{{model}} has no value`. A failed child settles with stopReason `error`; a
  // healthy child settles clean. The child's lifecycle renders on the
  // subagent tool_call card (kind `think`) — running then completed — and the
  // plan slot is left to todo alone.
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  const start = bridge.updates.length
  const result = await bridge.client.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'Call the subagent tool exactly once with run_in_background: false, description "regression-test", prompt "Reply with exactly: ok". Wait for it and report the result.' }],
  })
  assert.ok(['end_turn', 'max_tokens'].includes(result.stopReason), `prompt settled: ${result.stopReason}`)
  // Foreground waits for the child, so its lifecycle is observable on the
  // card: in_progress while running, then completed with no failure annotation.
  const run = await waitFor(() => {
    const call = bridge.updates.slice(start).find(update =>
      update.kind === 'session_update' && update.tag === 'tool_call'
      && update.update.title === 'subagent')
    if (call === undefined) return undefined
    const states = bridge.updates.slice(start).filter(update =>
      update.kind === 'session_update' && update.tag === 'tool_call_update'
      && update.update.toolCallId === call.update.toolCallId).map(update => update.update.status)
    const completed = states.findIndex(status => status === 'completed')
    const failed = states.some(status => /^failed/.test(String(status)))
    return completed !== -1 && !failed ? { call, states, completed } : undefined
  }, 120000)
  assert.ok(run, 'subagent card settles completed with no failure annotation')
  assert.equal(run.call.update.kind, 'think', 'subagent card kind is `think`')
  const running = run.states.indexOf('in_progress')
  assert.ok(running !== -1 && running < run.completed,
    'subagent card flips in_progress before completed')
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('allow_always grants once and skips later pushes for the same tool (P2-3)', { skip: !PROMPT_AVAILABLE }, async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  bridge.answerPermission({ outcome: 'selected', optionId: 'allow_always' })
  const first = await bridge.client.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'Run: touch ~/dshacp-allow-always-1. If you hit a sandbox denial, retry the exact same command once with sandbox_permissions and a one-sentence justification, then confirm it worked.' }],
  })
  assert.ok(['end_turn', 'max_tokens'].includes(first.stopReason), `first prompt settled: ${first.stopReason}`)
  const firstPermission = await waitFor(() => bridge.updates.find(update =>
    update.kind === 'request_permission' && update.params.sessionId === created.sessionId))
  assert.ok(firstPermission.params.options.some(option => option.optionId === 'allow_always' && option.kind === 'allow_always'),
    'permission offers allow_always')

  // Second escalation of the same tool must not push a permission again.
  const before = bridge.updates.filter(update => update.kind === 'request_permission').length
  const second = await bridge.client.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'Run: touch ~/dshacp-allow-always-2. If you hit a sandbox denial, retry the exact same command once with sandbox_permissions and a one-sentence justification, then confirm it worked.' }],
  })
  assert.ok(['end_turn', 'max_tokens'].includes(second.stopReason), `second prompt settled: ${second.stopReason}`)
  const after = bridge.updates.filter(update => update.kind === 'request_permission').length
  assert.equal(after, before, 'no second permission push for the allowed tool')
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('P3 hybrid: write delegates to the client when it advertises fs.writeTextFile', { skip: !PROMPT_AVAILABLE }, async () => {
  const target = join(PROJECT_ROOT, '.hybrid-test-file.txt')
  await rm(target, { force: true })
  const hybrid = spawnBridge({
    env: { DSHACP_HYBRID: '1' },
    handlers: {
      writeTextFile: async (params) => {
        await writeFile(params.path, params.content, 'utf8')
      },
    },
  })
  try {
    await waitFor(async () => {
      try {
        await hybrid.client.initialize({
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
          clientInfo: { name: 'dshacp-hybrid-test', version: '0.0.1' },
        })
        return true
      } catch {
        return false
      }
    }, 60000)
    const created = await hybrid.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
    const result = await hybrid.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: `Use the write tool to create the file .hybrid-test-file.txt with exactly this content: hybrid hello` }],
    })
    assert.ok(['end_turn', 'max_tokens'].includes(result.stopReason), `prompt settled: ${result.stopReason}`)
    // The client must have received an fs/write_text_file request (hybrid), and
    // the harness-side handler applied it to disk.
    const request = await waitFor(() => hybrid.updates.find(update => update.kind === 'write_text_file'))
    assert.ok(request.params.path.endsWith('.hybrid-test-file.txt'), `path delegated: ${request.params.path}`)
    assert.match(request.params.content, /hybrid hello/, 'content delegated verbatim')
    await waitFor(async () => {
      try {
        return (await readFile(target, 'utf8')).includes('hybrid hello') ? true : undefined
      } catch {
        return undefined
      }
    }, 10000)
    const onDisk = await readFile(target, 'utf8')
    assert.ok(onDisk.includes('hybrid hello'), 'file written by the client handler')
    await hybrid.client.closeSession({ sessionId: created.sessionId })
  } finally {
    await hybrid.stop()
    await rm(target, { force: true })
  }
})

test('write tool result renders as ACP diff content, not model XML', { skip: !PROMPT_AVAILABLE }, async () => {
  const target = join(PROJECT_ROOT, '.acp-write-diff-test.txt')
  await rm(target, { force: true })
  try {
    const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
    const result = await bridge.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'Use the write tool to create the file .acp-write-diff-test.txt with exactly this content: diff hello' }],
    })
    assert.ok(['end_turn', 'max_tokens'].includes(result.stopReason), `prompt settled: ${result.stopReason}`)
    const writeCall = bridge.updates.find(update =>
      update.kind === 'session_update' && update.tag === 'tool_call'
      && update.update.title?.startsWith('Write'))
    assert.ok(writeCall, 'write tool_call card created with Write title')
    const settled = settledToolCall(bridge.updates, writeCall.update.toolCallId)
    assert.ok(settled, 'write tool_call_update settled')
    assert.equal(settled.update.status, 'completed')
    assert.ok(Array.isArray(settled.update.content) && settled.update.content.length > 0,
      'completed write carries content blocks')
    assert.equal(settled.update.content[0].type, 'diff')
    assert.ok(settled.update.content[0].path.endsWith('.acp-write-diff-test.txt'))
    assert.match(settled.update.content[0].newText, /diff hello/)
    assert.equal(settled.update.rawOutput, undefined, 'successful diff omits model-facing rawOutput')
    await bridge.client.closeSession({ sessionId: created.sessionId })
  } finally {
    await rm(target, { force: true })
  }
})

test('P3 hybrid: a client write refusal surfaces as a tool failure, not a crash', { skip: !PROMPT_AVAILABLE }, async () => {
  const hybrid = spawnBridge({
    env: { DSHACP_HYBRID: '1' },
    handlers: {
      writeTextFile: async () => {
        throw new Error('client refused the write')
      },
    },
  })
  try {
    await waitFor(async () => {
      try {
        await hybrid.client.initialize({
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
          clientInfo: { name: 'dshacp-hybrid-fail-test', version: '0.0.1' },
        })
        return true
      } catch {
        return false
      }
    }, 60000)
    const created = await hybrid.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
    const result = await hybrid.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'Use the write tool to create .hybrid-fail-test.txt with content: xyz. Report what happened.' }],
    })
    assert.ok(['end_turn', 'max_tokens'].includes(result.stopReason), `prompt settled: ${result.stopReason}`)
    const request = await waitFor(() => hybrid.updates.find(update => update.kind === 'write_text_file'))
    const toolId = await waitFor(() => {
      const call = hybrid.updates.find(update =>
        update.kind === 'session_update' && update.tag === 'tool_call'
        && update.update.title === 'write')
      return call?.update.toolCallId
    })
    const settled = await waitFor(() => settledToolCall(hybrid.updates, toolId))
    assert.match(String(settled.update.rawOutput), /client write failed|refused/i,
      'the refusal is visible in the tool outcome')
    assert.ok(request.params.path.endsWith('.hybrid-fail-test.txt'))
    await hybrid.client.closeSession({ sessionId: created.sessionId })
  } finally {
    await hybrid.stop()
    await rm(join(PROJECT_ROOT, '.hybrid-fail-test.txt'), { force: true })
  }
})

test('approval bridge: a bash escalation surfaces as request_permission and allow-once grants it', { skip: !PROMPT_AVAILABLE }, async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  // Home-directory write → sandbox denial → model escalates with
  // sandbox_permissions → approval/request → bridge pushes request_permission.
  bridge.answerPermission({ outcome: 'selected', optionId: 'allow_once' })
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
    ['allow_once', 'allow_always', 'reject_once'],
    'permission offers allow_once + allow_always + reject_once',
  )
  // The tool must have completed (not failed) after the grant.
  const toolId = permission.params.toolCall.toolCallId
  const completed = await waitFor(() => bridge.updates.find(update =>
    update.kind === 'session_update' && update.tag === 'tool_call_update'
    && update.update.toolCallId === toolId && update.update.status === 'completed'))
  assert.ok(completed, 'granted tool call completed')
  const toolCalls = bridge.updates.filter(update =>
    update.kind === 'session_update' && update.tag === 'tool_call' && update.update.toolCallId === toolId)
  assert.match(String(toolCalls[0].update.title), /touch ~\/dshacp-approval-probe/,
    'execute card title shows the command content, not the bare tool name')
  assert.notEqual(toolCalls[0].update.title, 'bash')
  assert.equal(toolCalls[0].update.kind, 'execute')
  await bridge.client.closeSession({ sessionId: created.sessionId })
})

test('approval bridge: reject-once fails the tool closed', { skip: !PROMPT_AVAILABLE }, async () => {
  const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
  bridge.answerPermission({ outcome: 'selected', optionId: 'reject_once' })
  const result = await bridge.client.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'Run: touch ~/dshacp-approval-probe. If you hit a sandbox denial, retry the exact same command once with sandbox_permissions and a one-sentence justification, then report what happened.' }],
  })
  assert.ok(['end_turn', 'max_tokens'].includes(result.stopReason), `prompt settled: ${result.stopReason}`)
  const permission = await waitFor(() => bridge.updates.find(update =>
    update.kind === 'request_permission' && update.params.sessionId === created.sessionId))
  const toolId = permission.params.toolCall.toolCallId
  // The DSH tool surfaces the rejection as a completed result whose text
  // reports the refusal (the approval is final — nothing wider ran). The
  // first tool_call_update is the in_progress transition; wait for the
  // settling update.
  const settled = await waitFor(() => settledToolCall(bridge.updates, toolId))
  assert.ok(settled.update.status === 'completed' || settled.update.status === 'failed',
    `rejected call settled as ${settled.update.status}`)
  assert.match(String(settled.update.rawOutput), /reject/i, 'rawOutput reports the rejection')
  await bridge.client.closeSession({ sessionId: created.sessionId })
})
