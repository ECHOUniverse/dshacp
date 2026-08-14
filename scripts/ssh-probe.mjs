import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
const child = spawn('node', ['lib/bin.js'], { cwd: '/Volumes/WD-1T/00_Workspace/00_Active/CodeProject/DSHACP', stdio: ['pipe','pipe','inherit'], env: { ...process.env, DSH_SESSIONS_ROOT: '/tmp/ssh-probe-sessions' } })
const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
const client = new ClientSideConnection(() => ({
  requestPermission: async () => ({ outcome: 'cancelled' }),
  readTextFile: async () => ({ content: '' }),
  writeTextFile: async () => null,
  sessionUpdate: async (params) => {
    const u = params.update
    if (u.sessionUpdate === 'tool_call') console.log(`>>> tool_call ${u.title} kind=${u.kind} ${JSON.stringify(u.rawInput ?? {}).slice(0,150)}`)
    else if (u.sessionUpdate === 'tool_call_update') console.log(`>>> tool_update ${u.toolCallId} ${u.status} raw=${String(u.rawOutput).slice(0,200)}`)
    else if (u.sessionUpdate === 'agent_message_chunk') process.stdout.write(String(u.content.text))
  },
}), stream)
await client.initialize({ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'p', version: '0' } })
const created = await client.newSession({ cwd: process.cwd(), mcpServers: [] })
const r = await client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'Call the ssh_list tool once and report exactly what it returns.' }] })
console.log('\n>>> stopReason', r.stopReason)
child.kill()
