export class TranscriptSource {
  constructor(options = {}) {
    this.onError = options.onError ?? (() => {})
    this.readTurn = options.readTurn
    this.turns = new Map()
    this.listeners = new Set()
  }

  publish(turn) {
    const key = `${turn.transcriptId}\u0000${turn.sequence}`
    if (this.turns.has(key)) return
    const value = turnLocator(turn)
    this.turns.set(key, value)
    for (const listener of this.listeners) this.notify(listener, value)
  }

  subscribe(listener) {
    for (const turn of this.turns.values()) this.notify(listener, turn)
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  read(turn) {
    if (typeof this.readTurn !== 'function') {
      throw new Error('Transcript source does not support persisted turn reads')
    }
    return this.readTurn(structuredClone(turn))
  }

  notify(listener, turn) {
    try {
      listener(structuredClone(turn))
    } catch (error) {
      this.onError(error)
    }
  }
}

function turnLocator(turn) {
  return {
    transcriptId: turn.transcriptId,
    taskId: turn.taskId,
    title: turn.title || '',
    sequence: turn.sequence,
    turnId: turn.turnId,
    sessionId: turn.sessionId,
    ...(turn.executorTurnId ? { executorTurnId: turn.executorTurnId } : {}),
  }
}
