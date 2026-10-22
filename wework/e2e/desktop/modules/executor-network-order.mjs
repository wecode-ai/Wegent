import assert from 'node:assert/strict'

// Chromium pauses the real transport. No RPC result, event or history is synthesized.
export class ExecutorNetworkOrder {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    this.records = []
    this.mode = null
    this.heldHistory = []
    this.holdTerminalHistory = false
    this.error = null
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values())
        pending.reject(new Error('Renderer debugging connection closed'))
      this.pending.clear()
    })
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) pending?.reject(new Error(message.error.message))
        else pending?.resolve(message.result)
      } else if (message.method === 'Fetch.requestPaused') {
        void this.paused(message.params).catch(error => {
          this.error = error
        })
      }
    })
  }

  static async connect(port, origin, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    let target
    while (Date.now() < deadline) {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      target = (await response.json()).find(
        item => item.type === 'page' && item.url.startsWith(origin)
      )
      if (target) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(target?.webSocketDebuggerUrl, 'The real Wework renderer has no debugging target')
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    const order = new ExecutorNetworkOrder(socket)
    await order.call('Fetch.enable', {
      patterns: [
        { urlPattern: '*/wework/executor/v1/rpc', requestStage: 'Request' },
        { urlPattern: '*/wework/executor/v1/rpc', requestStage: 'Response' },
      ],
    })
    return order
  }

  call(method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Renderer transport command timed out: ${method}`))
      }, 10_000)
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async paused(event) {
    const body = JSON.parse(event.request.postData ?? '{}')
    const responseStage = event.responseStatusCode !== undefined
    const answer =
      body.method === 'runtime.tasks.send' &&
      Boolean(body.params?.requestUserInputResponse ?? body.params?.request_user_input_response)
    // Retain only protocol method and ordering, never prompts, answers or auth.
    if (answer) this.answerAddress = body.params.address
    const record = {
      method: body.method,
      responseStage,
      answer,
      answerTask: Boolean(
        this.answerAddress?.taskId &&
        (body.params?.address?.taskId ?? body.params?.taskId) === this.answerAddress.taskId
      ),
    }
    record.terminalHistory = Boolean(
      record.answerTask &&
      responseStage &&
      body.method === 'runtime.tasks.transcript' &&
      body.params?.includeFullContent === true
    )
    this.records.push(record)
    if (record.terminalHistory && this.holdTerminalHistory) {
      record.heldHistory = true
      this.heldHistory.push(event.requestId)
      return
    }
    if (answer && this.mode === 'reject-answer' && !responseStage) {
      this.mode = null
      record.rejected = true
      await this.call('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' })
      return
    }
    if (answer && this.mode === 'hold-answer' && responseStage) {
      record.held = true
      this.heldAnswer = event.requestId
      return
    }
    await this.call('Fetch.continueRequest', { requestId: event.requestId })
  }

  async releaseAnswer() {
    assert.ok(this.heldAnswer, 'No real answer acknowledgment was held')
    const requestId = this.heldAnswer
    this.heldAnswer = null
    this.mode = null
    await this.call('Fetch.continueRequest', { requestId })
  }

  async releaseHistory() {
    assert.ok(this.heldHistory.length > 0, 'No real terminal history was held')
    this.holdTerminalHistory = false
    for (const requestId of this.heldHistory.splice(0)) {
      await this.call('Fetch.continueRequest', { requestId })
    }
  }

  async waitFor(predicate, description, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.error) throw this.error
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.fail(`${description}: ${JSON.stringify(this.records)}`)
  }

  async close() {
    await this.call('Fetch.disable')
    this.socket.close()
    if (this.error) throw this.error
  }
}
