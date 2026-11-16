import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

/** The public CI provider controls actual Executor process shutdown and startup. */
export class LocalSandboxProcessController {
  constructor(onRestart) {
    assert.equal(typeof onRestart, 'function', 'A sandbox must have a real process controller')
    this.onRestart = onRestart
    this.requests = []
  }

  async start() {
    this.server = createServer((request, response) => {
      const url = new URL(request.url, this.endpoint)
      const match = url.pathname.match(/^\/e2e\/sandboxes\/([^/]+)\/restart$/)
      request.resume()
      if (request.method !== 'POST' || !match) {
        response.writeHead(404)
        response.end()
        return
      }
      try {
        const sandboxId = decodeURIComponent(match[1])
        this.onRestart(sandboxId)
        this.requests.push({ sandboxId })
        response.writeHead(202)
        response.end()
      } catch (error) {
        this.failure ??= error
        response.writeHead(500)
        response.end()
      }
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.endpoint = `http://127.0.0.1:${this.server.address().port}`
    return this
  }

  async waitForRestartRequest(afterCount) {
    const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
    while (Date.now() < deadline) {
      assert.ifError(this.failure)
      const request = this.requests[afterCount]
      if (request) return request
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('The sandbox process controller did not receive a restart request')
  }

  async stop() {
    if (this.server) {
      this.server.closeAllConnections()
      await new Promise(resolve => this.server.close(resolve))
    }
    assert.ifError(this.failure)
  }
}
