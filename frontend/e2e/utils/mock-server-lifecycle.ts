import type { Server } from 'node:http'
import { closePreviewFileSource } from './preview-file-source'

export function startMockServer(server: Server, port: number): void {
  // Start the server
  server.listen(port, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║           Mock Model Server for E2E Testing                ║
╠════════════════════════════════════════════════════════════╣
║  Server running on: http://localhost:${port}                  ║
║                                                            ║
║  Endpoints:                                                ║
║    POST /v1/responses        - Mock OpenAI Responses API   ║
║    POST /v1/chat/completions - Mock OpenAI chat API        ║
║    POST /v1/messages         - Mock Anthropic Messages API ║
║    GET  /captured-requests   - View captured requests      ║
║    POST /clear-requests      - Clear captured requests     ║
║    GET  /stream-rules        - View stream rules           ║
║    POST /stream-rules        - Add a matched stream rule   ║
║    DELETE /stream-rules      - Clear stream rules          ║
║    POST /tool-scenarios      - Add a tool-call scenario    ║
║    GET  /tool-scenarios      - View one tool-call scenario ║
║    DELETE /tool-scenarios    - Clear tool-call scenarios   ║
║    POST /mcp                 - Mock Streamable HTTP MCP    ║
║    GET  /mcp-control/calls   - View provider tool calls    ║
║    POST /mcp-control/reset   - Reset provider state        ║
║    GET  /health              - Health check                ║
║                                                            ║
║  Configure your model to use:                              ║
║    Base URL: http://localhost:${port}/v1                      ║
║    API Key: any-value                                      ║
╚════════════════════════════════════════════════════════════╝
`)
  })

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down mock server...')
    await closePreviewFileSource()
    server.close(() => {
      console.log('Server closed')
      process.exit(0)
    })
  })
}
