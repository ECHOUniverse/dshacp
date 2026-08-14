// Quick end-to-end probe: spawn the built bin, drive it like Zed does.
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'

const child = spawn('node', ['lib/bin.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: ['pipe', 'pipe', 'inherit'],
})
const stream = ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
)
const client = new ClientSideConnection(() => ({
  requestPermission: async () => ({ outcome: 'cancelled' }),
  readTextFile: async () => ({ content: '' }),
  writeTextFile: async () => null,
  sessionUpdate: async (params) => {
    const u = params.update
    const tag = u.sessionUpdate
    if (tag === 'agent_message_chunk') process.stdout.write(`[msg] ${u.content.text}`)
    else if (tag === 'agent_thought_chunk') process.stdout.write(`[thought] ${u.content.text}\n`)
    else if (tag === 'tool_call') process.stdout.write(`\n[tool_call] ${u.title} ${u.toolCallId} ${JSON.stringify(u.rawInput ?? null)}\n`)
    else if (tag === 'tool_call_update') process.stdout.write(`[tool_update] ${u.toolCallId} ${u.status}\n`)
    else if (tag === 'plan') process.stdout.write(`[plan] ${u.entries.map(e => `${e.status}:${e.content}`).join(' | ')}\n`)
    else if (tag === 'usage_update') process.stdout.write(`[usage] used=${u.used} size=${u.size}\n`)
    else if (tag === 'session_info_update') process.stdout.write(`[info] title=${u.title}\n`)
    else process.stdout.write(`[${tag}]\n`)
  },
}), stream)

try {
  const init = await client.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: 'probe', version: '0.0.1' },
  })
  console.log('\nINIT OK', JSON.stringify(init.agentCapabilities))
  const created = await client.newSession({ cwd: process.cwd(), mcpServers: [] })
  console.log('NEW OK', created.sessionId)
  const listed = await client.listSessions({})
  console.log('LIST OK', listed.sessions.map(s => `${s.sessionId} "${s.title}"`).join(', '))
  console.log('\n--- prompt ---')
  const result = await client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'Reply with exactly: hello world' }] })
  console.log('\nPROMPT OK stopReason=', result.stopReason)
  const listed2 = await client.listSessions({})
  console.log('LIST2 OK', listed2.sessions.map(s => `"${s.title}"`).join(', '))
  await client.closeSession({ sessionId: created.sessionId })
  console.log('CLOSE OK')
} catch (error) {
  console.error('\nPROBE FAILED:', error)
  process.exitCode = 1
} finally {
  child.kill()
}
