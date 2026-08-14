// Debug resume: prompt a secret word, close, resume, ask again.
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'

const child = spawn('node', ['lib/bin.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, DSH_SESSIONS_ROOT: './.debug-sessions' },
})
const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
const updates = []
const client = new ClientSideConnection(() => ({
  requestPermission: async () => ({ outcome: 'cancelled' }),
  readTextFile: async () => ({ content: '' }),
  writeTextFile: async () => null,
  sessionUpdate: async (params) => updates.push(params.update),
}), stream)

await client.initialize({ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'probe', version: '0' } })
const created = await client.newSession({ cwd: process.cwd(), mcpServers: [] })
let r = await client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'Remember the secret word: zephyr. Reply: noted.' }] })
console.log('first stopReason', r.stopReason)
await client.closeSession({ sessionId: created.sessionId })
updates.length = 0
await client.resumeSession({ sessionId: created.sessionId, cwd: process.cwd() })
console.log('resumed; updates during resume:', updates.length)
updates.length = 0
r = await client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'What was the secret word? Reply with only that word.' }] })
console.log('second stopReason', r.stopReason)
for (const u of updates) {
  if (u.sessionUpdate === 'agent_message_chunk') console.log('msg:', JSON.stringify(u.content.text))
  else if (u.sessionUpdate === 'agent_thought_chunk') console.log('thought:', JSON.stringify(u.content.text))
  else if (u.sessionUpdate === 'tool_call') console.log('tool:', u.title)
}
child.kill()
