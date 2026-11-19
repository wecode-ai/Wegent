import { setTimeout } from 'node:timers/promises'

export async function waitForTerminalStatus(methods, exportTaskId, signal) {
  for (;;) {
    signal.throwIfAborted()
    const status = await methods.status({ exportTaskId })
    if (['completed', 'failed', 'cancelled'].includes(status.state)) return status
    await setTimeout(10, undefined, { signal })
  }
}
