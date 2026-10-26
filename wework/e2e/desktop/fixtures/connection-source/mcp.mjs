import { createInterface } from 'node:readline'
import { appendFile, readFile } from 'node:fs/promises'

// A real, locally installed MCP plugin that reads a test-owned record file.
const [recordsPath, auditPath] = process.argv.slice(2)
const tools = [
  {
    name: 'read_record',
    description: 'Read a local record',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'write_record',
    description: 'Write a local record',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
]
const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  const message = JSON.parse(line)
  if (message.id === undefined) continue
  let result
  if (message.method === 'initialize')
    result = {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'connection-source', version: '1.0.0' },
    }
  else if (message.method === 'tools/list') result = { tools }
  else if (message.method === 'tools/call') {
    await appendFile(auditPath, `${JSON.stringify(message.params)}\n`)
    const records = JSON.parse(await readFile(recordsPath, 'utf8'))
    const record = records.find(item => item.id === message.params.arguments.query)
    result = {
      content: [{ type: 'text', text: JSON.stringify(record) }],
      structuredContent: record,
      isError: !record,
    }
  } else if (message.method === 'ping') result = {}
  else {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`
    )
    continue
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
}
