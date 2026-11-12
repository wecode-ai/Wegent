import type { WebContents } from 'electron'
import { withDebuggerSession } from './debugger-session.js'

export class BrowserScriptEvaluator {
  private readonly actions = new Set<Promise<void>>()

  constructor(private readonly contents: WebContents) {}

  async evaluate(expression: string, options: { awaitPromise?: boolean } = {}): Promise<unknown> {
    let complete: (() => void) | undefined
    const action =
      options.awaitPromise === false
        ? new Promise<void>(resolve => {
            complete = resolve
          })
        : null
    if (action) this.actions.add(action)
    try {
      return await withDebuggerSession(this.contents, async target => {
        const { result, exceptionDetails } = await target.sendCommand('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: options.awaitPromise ?? true,
          userGesture: true,
        })
        if (exceptionDetails) {
          throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
        }
        return result.value
      })
    } finally {
      if (action) {
        this.actions.delete(action)
        complete?.()
      }
    }
  }

  async afterActions<T>(operation: () => Promise<T>): Promise<T> {
    // Host-driven navigation must not destroy an action's pending CDP response.
    while (this.actions.size) await Promise.all([...this.actions])
    return operation()
  }
}
