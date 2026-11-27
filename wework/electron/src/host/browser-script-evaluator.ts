import type { WebContents } from 'electron'
import { withDebuggerSession } from './debugger-session.js'

export interface BrowserScriptEvaluationOptions {
  awaitPromise?: boolean
  readOnly?: boolean
}

export class BrowserExpressionError extends Error {
  constructor(
    readonly kind: 'read_only_rejected' | 'javascript_exception',
    message: string
  ) {
    super(message)
  }
}

export class BrowserScriptEvaluator {
  private readonly actions = new Set<Promise<void>>()

  constructor(private readonly contents: WebContents) {}

  async evaluate(
    expression: string,
    options: BrowserScriptEvaluationOptions = {}
  ): Promise<unknown> {
    const awaitPromise = options.readOnly ? false : (options.awaitPromise ?? true)
    let complete: (() => void) | undefined
    const action = !awaitPromise
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
          awaitPromise,
          userGesture: !options.readOnly,
          ...(options.readOnly ? { throwOnSideEffect: true } : {}),
        })
        if (exceptionDetails) {
          const description = exceptionDetails.exception?.description ?? exceptionDetails.text
          if (options.readOnly) {
            const rejected = /^EvalError: Possible side-effect in debug-evaluate(?:\n|$)/.test(
              description
            )
            throw new BrowserExpressionError(
              rejected ? 'read_only_rejected' : 'javascript_exception',
              rejected
                ? 'Read-only browser evaluation rejected'
                : 'Browser expression evaluation failed'
            )
          }
          throw new Error(description)
        }
        return result.value
      })
    } catch (error) {
      console.warn('[embedded-browser-evaluation]', {
        contentsId: this.contents.id,
        awaitPromise,
        pendingActions: this.actions.size,
        error: options.readOnly
          ? 'Read-only browser evaluation failed'
          : error instanceof Error
            ? error.message
            : String(error),
      })
      throw error
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
