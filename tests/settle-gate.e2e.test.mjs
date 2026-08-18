// Settlement-gate e2e tests (prompt-settlement background-work note): a prompt
// whose turn ends but which spawned a background job must NOT settle `end_turn`
// before the owned job converges (or the background-settle timeout forces it).
// Prompt tests need a real model credential and skip without one.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { PROJECT_ROOT, TEST_HOME, TEST_SESSIONS, hasModelCredential, makeTestHome, spawnBridge, waitFor } from './harness.mjs'

const PROMPT_AVAILABLE = hasModelCredential()
console.error(`[dshacp settle-gate e2e] model credential ${PROMPT_AVAILABLE ? 'available' : 'NOT available (prompt tests skipped)'}`)

after(async () => {
  await rm(TEST_SESSIONS, { recursive: true, force: true })
  await rm(TEST_HOME, { recursive: true, force: true })
})

/** Spawn and initialize a bridge under a given background-settle timeout (ms). */
async function initBridge(backgroundMs) {
  const spawned = spawnBridge({ env: { DSHACP_BACKGROUND_SETTLE_MS: String(backgroundMs) } })
  await waitFor(async () => {
    try {
      await spawned.client.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'dshacp-settle-test', version: '0.0.1' },
      })
      return true
    } catch {
      return false
    }
  }, 60000)
  return spawned
}

test('a prompt with trailing background work does not settle before the job converges', { skip: !PROMPT_AVAILABLE }, async () => {
  // A 30s fallback is well beyond the job length, so this test exercises the
  // convergence path (not the timeout fallback): the prompt must stay pending
  // until the background `sleep` job settles, THEN return `end_turn`.
  const bridge = await initBridge(30_000)
  try {
    const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
    const started = Date.now()
    const prompt = bridge.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'Run a bash background job exactly once: `sleep 5` with run_in_background: true. Do NOT wait for it with job_output. Then end your turn immediately and say nothing else.' }],
    })
    const result = await prompt
    const elapsed = Date.now() - started
    assert.equal(result.stopReason, 'end_turn')
    // The gate must have held the prompt open for the background job to
    // converge (≈5s), rather than returning at the first idle. Allow generous
    // slack for model round-trips and the `wakeup` completion turn.
    assert.ok(elapsed >= 2000, `prompt held open for background convergence (elapsed ${elapsed}ms)`)
    await bridge.client.closeSession({ sessionId: created.sessionId })
  } finally {
    await bridge.stop()
  }
})

test('the background-settle timeout force-settles a prompt whose background job never surfaces', { skip: !PROMPT_AVAILABLE }, async () => {
  // Short fallback: even if the model starts a background job that outlives the
  // prompt, the prompt must NOT hang forever — it force-settles after the
  // configured timeout (this is the no-worse-than-before safety net).
  const bridge = await initBridge(3000)
  try {
    const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
    const started = Date.now()
    const prompt = bridge.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'Run a bash background job exactly once: `sleep 60` with run_in_background: true. Do NOT wait for it. Then end your turn immediately and say nothing else.' }],
    })
    const result = await prompt
    const elapsed = Date.now() - started
    assert.ok(['end_turn', 'max_tokens'].includes(result.stopReason), `prompt force-settled: ${result.stopReason}`)
    // The prompt should not have returned at the very first idle while the job
    // was running; it waited for the 3s timeout to force-settle.
    assert.ok(elapsed >= 2000, `prompt awaited the fallback timeout (elapsed ${elapsed}ms)`)
    await bridge.client.closeSession({ sessionId: created.sessionId })
  } finally {
    await bridge.stop()
  }
})

test('session/cancel still settles a prompt cancelled immediately while background runs (spec §3.4)', { skip: !PROMPT_AVAILABLE }, async () => {
  // Explicit cancel must remain authoritative and immediate: even though the
  // gate would otherwise hold the prompt open for a long-running background
  // job, a cancel must return `cancelled` without waiting for the job (or the
  // 30s background-settle timeout).
  //
  // The cancel is event-driven rather than timed: it fires the moment the
  // model's bash tool call appears on the wire (status `in_progress` ⇒ the
  // background job is starting), so the turn is guaranteed to still be open —
  // no race with a fast model that ends its turn before a fixed wait elapses.
  const bridge = await initBridge(30_000)
  try {
    const created = await bridge.client.newSession({ cwd: PROJECT_ROOT, mcpServers: [] })
    const prompt = bridge.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'Run a bash background job exactly once: `sleep 60` with run_in_background: true. Do NOT wait for it. Then end your turn immediately and say nothing else.' }],
    })
    // Wait for the model to start the background job (its bash card flips to
    // in_progress), then cancel immediately while the job is still running.
    await waitFor(() => bridge.updates.some(update =>
      update.kind === 'session_update' && update.tag === 'tool_call_update'
      && update.update.status === 'in_progress'), 20000)
    const started = Date.now()
    await bridge.client.cancel({ sessionId: created.sessionId })
    const result = await prompt
    const elapsed = Date.now() - started
    assert.equal(result.stopReason, 'cancelled')
    assert.ok(elapsed < 20_000, `cancel returned promptly, not after the background timeout (${elapsed}ms)`)
    await bridge.client.closeSession({ sessionId: created.sessionId })
  } finally {
    await bridge.stop()
  }
})
