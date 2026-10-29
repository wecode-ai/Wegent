export class WindowCommandQueue {
  #commands = []
  #clients = new Map()
  #windows = new Map()
  #waiting = new Map()

  constructor(headers) {
    this.headers = headers
  }

  get length() {
    return this.#commands.length
  }

  register(clientId, windowLabel) {
    const previous = this.#windows.get(windowLabel)
    if (previous && previous !== clientId) {
      this.#clients.delete(previous)
      this.#finish(previous, 410)
    }
    this.#clients.set(clientId, windowLabel)
    this.#windows.set(windowLabel, clientId)
  }

  enqueue(command) {
    const clientId = this.#windows.get(command.windowLabel)
    if (!this.#finish(clientId, 200, command)) this.#commands.push(command)
  }

  remove(commandId) {
    this.#commands = this.#commands.filter(command => command.id !== commandId)
  }

  poll(clientId, response, wait) {
    const windowLabel = this.#clients.get(clientId)
    if (!windowLabel) return this.#respond(response, 410)
    const index = this.#commands.findIndex(command => command.windowLabel === windowLabel)
    if (index >= 0) return this.#respond(response, 200, this.#commands.splice(index, 1)[0])
    if (!wait) return this.#respond(response, 204)

    this.#finish(clientId, 410)
    const timeout = setTimeout(() => this.#finish(clientId, 204), 25_000)
    this.#waiting.set(clientId, { response, timeout })
    response.once('close', () => {
      if (this.#waiting.get(clientId)?.response !== response) return
      clearTimeout(timeout)
      this.#waiting.delete(clientId)
    })
  }

  close() {
    for (const clientId of this.#waiting.keys()) this.#finish(clientId, 410)
    this.#clients.clear()
    this.#windows.clear()
    this.#commands = []
  }

  #finish(clientId, status, command) {
    const pending = this.#waiting.get(clientId)
    if (!pending) return false
    clearTimeout(pending.timeout)
    this.#waiting.delete(clientId)
    this.#respond(pending.response, status, command)
    return true
  }

  #respond(response, status, command) {
    response.writeHead(status, {
      ...this.headers,
      'Cache-Control': 'no-store',
      ...(command ? { 'Content-Type': 'application/json' } : {}),
    })
    response.end(command ? JSON.stringify(command) : undefined)
  }
}
