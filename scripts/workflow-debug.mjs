// Debug P2-1: workflow tool_call cards (kind `other`, running → completed) + allow_always.
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'

const child = spawn('node', ['lib/bin.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, DSH_SESSIONS_ROOT: './.debug-sessions' },
})
const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
let permissions = 0
const client = new ClientSideConnection(() => ({
  requestPermission: async (params) => {
    permissions++
    console.log(`>>> REQUEST_PERMISSION #${permissions}: ${params.toolCall.title}`)
    return { outcome: 'selected', optionId: 'allow_once' }
  },
  readTextFile: async () => ({ content: '' }),
  writeTextFile: async () => null,
  sessionUpdate: async (params) => {
    const u = params.update
    if (u.sessionUpdate === 'plan') console.log(`>>> plan: ${u.entries.map(e => `${e.status}:${e.content}`).join(' | ')}`)
    else if (u.sessionUpdate === 'tool_call') console.log(`>>> tool_call ${u.title} ${JSON.stringify(u.rawInput ?? {}).slice(0, 120)}`)
    else if (u.sessionUpdate === 'tool_call_update') console.log(`>>> tool_update ${u.toolCallId} ${u.status}`)
    else if (u.sessionUpdate === 'agent_message_chunk') process.stdout.write(String(u.content.text))
  },
}), stream)

await client.initialize({ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'probe', version: '0' } })
const created = await client.newSession({ cwd: process.cwd(), mcpServers: [] })
const r = await client.prompt({
  sessionId: created.sessionId,
  prompt: [{ type: 'text', text: 'Use the workflow tool to run this exact script and report its result: script meta: name "review-test", description "test workflow". Body: phase("setup"); log("hello"); return "workflow result: ok".' }],
})
console.log('\n>>> stopReason', r.stopReason)
child.kill()
