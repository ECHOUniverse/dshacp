// Shared e2e harness: spawn the built bin and drive it with the official
// client SDK over stdio — the same path Zed uses.
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * The isolated harness home this test process runs its bins under. One
 * directory per test-process pid: `node --test` runs each test file in its
 * own process, and a shared directory would let one file's rebuild race
 * another file's child boot.
 */
export const TEST_HOME = join(PROJECT_ROOT, `.test-home-${process.pid}`)

/**
 * The per-test-process sessions root (same rationale as {@link TEST_HOME}).
 */
export const TEST_SESSIONS = join(PROJECT_ROOT, `.test-sessions-${process.pid}`)

/**
 * Build (once) the isolated harness home the spawned bins run under. P4
 * compositions inherit the user's DSH configuration from `$DSH_HOME`
 * (settings.yaml, credentials, presets), so tests must pin a controlled home
 * instead of the machine's `~/.dsh` — otherwise the host's
 * `permission.defaultPreset` (e.g. `danger-full-access`) decides the sandbox
 * and approval behavior under test. The test home pins `workspace-write` and
 * mirrors the real credentials so model-backed tests keep running.
 */
export function makeTestHome() {
  rmSync(TEST_HOME, { recursive: true, force: true })
  mkdirSync(TEST_HOME, { recursive: true })
  writeFileSync(join(TEST_HOME, 'settings.yaml'), [
    'permission:',
    '  defaultPreset: workspace-write',
    'agent-default-model:',
    '  provider: deepseek-official',
    '  model: deepseek-v4-flash',
    '',
  ].join('\n'), 'utf8')
  // Mirror the real credentials document so prompt tests see a key exactly
  // where the child looks for one. Missing real credentials leave the temp
  // home without a key (prompt tests then skip).
  const real = homedir()
  for (const candidate of ['.credentials.yaml', '.env']) {
    try {
      copyFileSync(join(real, '.dsh', candidate), join(TEST_HOME, candidate))
    } catch {
      // the candidate does not exist on this machine; try the next one
    }
  }
  testHome = TEST_HOME
  return TEST_HOME
}

let testHome

/**
 * Spawn the DSHACP bin with a sandboxed persistence root and an isolated
 * harness home.
 * @param options - env overrides, child cwd, and client-handler overrides.
 */
export function spawnBridge(options = {}) {
  const { env = {}, cwd = PROJECT_ROOT, handlers = {} } = options
  const sessionsDir = env.DSH_SESSIONS_ROOT ?? TEST_SESSIONS
  if (env.DSH_HOME === undefined && testHome === undefined) testHome = makeTestHome()
  const child = spawn('node', ['lib/bin.js'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(env.DSH_HOME !== undefined ? { DSH_HOME: env.DSH_HOME } : testHome !== undefined ? { DSH_HOME: testHome } : {}),
      DSH_SESSIONS_ROOT: sessionsDir,
      ...env,
    },
  })
  const updates = []
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  )
  const client = new ClientSideConnection(() => ({
    requestPermission: async (params) => {
      updates.push({ kind: 'request_permission', params })
      return pendingPermissions.length > 0
        ? pendingPermissions.shift()
        : { outcome: 'cancelled' }
    },
    readTextFile: async (params) => {
      updates.push({ kind: 'read_text_file', params })
      return handlers.readTextFile ? handlers.readTextFile(params) : { content: '' }
    },
    writeTextFile: async (params) => {
      updates.push({ kind: 'write_text_file', params })
      return handlers.writeTextFile ? handlers.writeTextFile(params) : null
    },
    unstable_createElicitation: async (params) => {
      updates.push({ kind: 'elicitation', params })
      return handlers.unstable_createElicitation
        ? handlers.unstable_createElicitation(params)
        : { action: 'cancel' }
    },
    sessionUpdate: async (params) => {
      const tag = params.update.sessionUpdate
      updates.push({ kind: 'session_update', tag, sessionId: params.sessionId, update: params.update })
    },
  }), stream)

  /** Queue the next permission-request answer (FIFO). */
  const pendingPermissions = []
  const answerPermission = (outcome, optionId) => {
    pendingPermissions.push(optionId !== undefined ? { outcome, optionId } : { outcome })
  }

  return {
    child,
    client,
    updates,
    answerPermission,
    get stderr() {
      return stderr.join('')
    },
    /** Kill the child and settle. */
    async stop() {
      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

/**
 * Whether a real model credential is available in the harness home (skip
 * guard for prompt tests).
 */
export function hasModelCredential() {
  if (testHome === undefined) testHome = makeTestHome()
  for (const candidate of [`${testHome}/.credentials.yaml`, `${testHome}/.env`]) {
    try {
      const content = readFileSync(candidate, 'utf8')
      if (/DEEPSEEK_API_KEY\s*:\s*\S/.test(content)) return true
    } catch {
      // try the next candidate
    }
  }
  return Boolean(process.env.DEEPSEEK_API_KEY)
}

/** Wait until a predicate over collected updates holds, or fail after a timeout. */
export async function waitFor(predicate, timeoutMs = 30000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
}
