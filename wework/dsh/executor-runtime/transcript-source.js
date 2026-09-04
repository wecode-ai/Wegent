export class TranscriptSource {
  constructor(options = {}) {
    this.onError = options.onError ?? (() => {})
    this.turns = new Map()
    this.listeners = new Set()
  }

  publish(turn) {
    const key = `${turn.transcriptId}\u0000${turn.sequence}`
    if (this.turns.has(key)) return
    this.turns.set(key, structuredClone(turn))
    for (const listener of this.listeners) this.notify(listener, turn)
  }

  subscribe(listener) {
    for (const turn of this.turns.values()) this.notify(listener, turn)
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify(listener, turn) {
    try {
      listener(structuredClone(turn))
    } catch (error) {
      this.onError(error)
    }
  }
}
