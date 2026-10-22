import { subscribeDshTerminalEvents } from '@/api/dsh/terminalTransport'
import { getLocalTerminalSnapshot, listLocalHarnessSessions } from '@/lib/local-terminal'

interface TerminalHistory {
  output: string
  exit?: { emittedAt: string; code: unknown; signal: unknown }
}

const terminalHistory = new Map<string, TerminalHistory>()
let installed = false

export function installLocalHarnessDiagnostics(): void {
  if (installed) return
  installed = true
  subscribeDshTerminalEvents(event => {
    const sessionId = event.payload.session_id
    if (
      typeof sessionId !== 'string' ||
      !['terminal.output', 'terminal.exit'].includes(event.event)
    ) {
      return
    }
    const history = terminalHistory.get(sessionId) ?? { output: '' }
    if (event.event === 'terminal.output' && typeof event.payload.data === 'string') {
      history.output = (history.output + event.payload.data).slice(-20_000)
    } else if (event.event === 'terminal.exit') {
      history.exit = {
        emittedAt: event.emittedAt,
        code: event.payload.exit_code,
        signal: event.payload.signal,
      }
    }
    terminalHistory.set(sessionId, history)
    if (terminalHistory.size > 32) {
      terminalHistory.delete(terminalHistory.keys().next().value!)
    }
  })
}

export async function collectLocalHarnessDiagnostics() {
  const sessions = await listLocalHarnessSessions()
  return Promise.all(
    sessions.map(async session => ({
      sessionId: session.session_id,
      harnessId: session.harness_id,
      active: session.active,
      history: terminalHistory.get(session.session_id),
      terminal: await getLocalTerminalSnapshot(session.session_id).then(
        snapshot => ({
          sequence: snapshot.sequence,
          running: snapshot.running,
          output: snapshot.data.slice(-20_000),
        }),
        error => ({ error: error instanceof Error ? error.message : String(error) })
      ),
    }))
  )
}
