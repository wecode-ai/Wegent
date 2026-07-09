const MAX_TERMINAL_BUFFER_CHUNKS = 500
const terminalOutputBuffers = new Map<string, string[]>()

export function appendTerminalOutput(sessionId: string, data: string) {
  const chunks = terminalOutputBuffers.get(sessionId) ?? []
  chunks.push(data)
  if (chunks.length > MAX_TERMINAL_BUFFER_CHUNKS) {
    chunks.splice(0, chunks.length - MAX_TERMINAL_BUFFER_CHUNKS)
  }
  terminalOutputBuffers.set(sessionId, chunks)
}

export function readTerminalOutput(sessionId: string): string {
  return terminalOutputBuffers.get(sessionId)?.join('') ?? ''
}

export function clearTerminalOutput(sessionId: string) {
  terminalOutputBuffers.delete(sessionId)
}
