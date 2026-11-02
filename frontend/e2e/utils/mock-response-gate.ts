import type { ServerResponse } from 'node:http'

/** Hold model responses until the test releases them, including later pipeline stages. */
export class MockResponseGate {
  private released = false
  private readonly pending = new Set<() => void>()

  async wait(response: ServerResponse): Promise<void> {
    if (this.released || response.destroyed) return
    await new Promise<void>(resolve => {
      const finish = () => {
        this.pending.delete(finish)
        response.off('close', finish)
        resolve()
      }
      this.pending.add(finish)
      response.once('close', finish)
    })
  }

  release(): number {
    this.released = true
    const count = this.pending.size
    for (const finish of this.pending) finish()
    return count
  }
}
