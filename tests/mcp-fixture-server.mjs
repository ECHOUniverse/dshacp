// Minimal MCP stdio server for the MCP-forwarding e2e test: speaks the MCP
// JSON-RPC handshake and serves one tool (`fixture_echo`). Not a product
// file — the bridge under test must be able to forward it like any stdio
// MCP server (the dsh-mcp-client connects with the official MCP SDK).
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
const pending = new Map()

rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id !== undefined) {
    const request = message
    const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
    const respondError = (code, text) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code, message: text } }) + '\n')
    try {
      switch (request.method) {
        case 'initialize':
          respond({
            protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'dshacp-fixture-mcp', version: '0.0.1' },
          })
          break
        case 'tools/list':
          respond({
            tools: [{
              name: 'fixture_echo',
              description: 'Echo a message back.',
              inputSchema: {
                type: 'object',
                properties: { message: { type: 'string' } },
                required: ['message'],
              },
            }],
          })
          break
        case 'tools/call': {
          const name = request.params?.name
          const args = request.params?.arguments ?? {}
          if (name === 'fixture_echo') {
            respond({ content: [{ type: 'text', text: `fixture echoed: ${args.message ?? ''}` }] })
          } else {
            respondError(-32602, `unknown tool: ${String(name)}`)
          }
          break
        }
        default:
          respondError(-32601, `method not found: ${request.method}`)
      }
    } catch (error) {
      respondError(-32603, error instanceof Error ? error.message : String(error))
    }
  } else if (message.method === 'notifications/initialized') {
    // no reply expected
  }
})

// Keep the process alive until stdin closes.
process.stdin.resume()
