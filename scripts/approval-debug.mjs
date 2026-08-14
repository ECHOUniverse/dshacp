// Debug: watch all updates during an escalation prompt.
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'

const child = spawn('node', ['lib/bin.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, DSH_SESSIONS_ROOT: process.env.DSH_SESSIONS_ROOT ?? './.debug-sessions' },
})
const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
const client = new ClientSideConnection(() => ({
  requestPermission: async (params) => {
    console.log('>>> REQUEST_PERMISSION', JSON.stringify(params).slice(0, 400))
    return { outcome: 'selected', optionId: 'reject_once' }
  },
  readTextFile: async () => ({ content: '' }),
  writeTextFile: async () => null,
  sessionUpdate: async (params) => {
    const u = params.update
    if (u.sessionUpdate === 'tool_call') console.log(`>>> tool_call ${u.title} ${JSON.stringify(u.rawInput).slice(0, 200)}`)
    else if (u.sessionUpdate === 'tool_call_update') console.log(`>>> tool_update ${u.toolCallId} ${u.status} raw=${JSON.stringify(u.rawOutput)}`)
    else if (u.sessionUpdate === 'agent_message_chunk') process.stdout.write(String(u.content.text))
    else if (u.sessionUpdate === 'agent_thought_chunk') console.log(`>>> thought: ${u.content.text}`)
  },
}), stream)

await client.initialize({ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'probe', version: '0' } })
const created = await client.newSession({ cwd: process.cwd(), mcpServers: [] })
console.log('session', created.sessionId)
const result = await client.prompt({
  sessionId: created.sessionId,
  prompt: [{ type: 'text', text: 'Run: touch ~/dshacp-approval-probe. If you hit a sandbox denial, retry the exact same command once with sandbox_permissions and a one-sentence justification, then report the first line of output.' }],
})
console.log('\n>>> stopReason', result.stopReason)
child.kill()
