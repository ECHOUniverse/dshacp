// Shared e2e harness: spawn the built bin and drive it with the official
// client SDK over stdio — the same path Zed uses.
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Spawn the DSHACP bin with a sandboxed persistence root.
 * @param options - env overrides, child cwd, and client-handler overrides.
 */
export function spawnBridge(options = {}) {
  const { env = {}, cwd = PROJECT_ROOT, handlers = {} } = options
  const sessionsDir = env.DSH_SESSIONS_ROOT ?? `${PROJECT_ROOT}/.test-sessions`
  const child = spawn('node', ['lib/bin.js'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DSH_SESSIONS_ROOT: sessionsDir, ...env },
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
    sessionUpdate: async (params) => {
      const tag = params.update.sessionUpdate
      updates.push({ kind: 'session_update', tag, update: params.update })
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

/** Whether a real model credential is available (skip guard for prompt tests). */
export async function hasModelCredential() {
  try {
    const { readFile } = await import('node:fs/promises')
    const { homedir } = await import('node:os')
    const home = homedir()
    for (const candidate of [`${home}/.dsh/.credentials.yaml`, `${home}/.dsh/.env`]) {
      try {
        const content = await readFile(candidate, 'utf8')
        if (/DEEPSEEK_API_KEY\s*:\s*\S/.test(content)) return true
      } catch {
        // try the next candidate
      }
    }
    return Boolean(process.env.DEEPSEEK_API_KEY)
  } catch {
    return false
  }
}
