import type { WebContents } from 'electron'
import { withDebuggerSession } from './debugger-session.js'

export type BrowserConditionResult =
  | { kind: 'value'; value: unknown }
  | { kind: 'document-changed' }

export type BrowserConditionEvaluator = (
  expression: string,
  remainingMs: number
) => Promise<BrowserConditionResult>

export class BrowserConditionTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for embedded browser condition')
  }
}

class EvaluationTransportError extends Error {
  constructor(cause: unknown) {
    super('Embedded browser evaluation transport failed', { cause })
  }
}

interface EvaluationOptions {
  awaitPromise?: boolean
  signal?: AbortSignal
}

export function awaitBrowserOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  let abort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  return Promise.race([operation, aborted]).finally(() => {
    signal.removeEventListener('abort', abort)
  })
}

async function evaluateScript(
  contents: WebContents,
  expression: string,
  options: EvaluationOptions
): Promise<unknown> {
  options.signal?.throwIfAborted()
  return withDebuggerSession(contents, async target => {
    let response
    try {
      response = await awaitBrowserOperation(
        target.sendCommand('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: options.awaitPromise ?? true,
          userGesture: true,
        }),
        options.signal
      )
    } catch (error) {
      options.signal?.throwIfAborted()
      throw new EvaluationTransportError(error)
    }
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text
      )
    }
    return response.result.value
  })
}

export async function evaluateBrowserScript(
  contents: WebContents,
  expression: string,
  options: { awaitPromise?: boolean }
): Promise<unknown> {
  try {
    return await evaluateScript(contents, expression, options)
  } catch (error) {
    throw error instanceof EvaluationTransportError ? error.cause : error
  }
}

interface ConditionTarget {
  contents: WebContents
  isCurrent(): boolean
  waitForNavigation(remainingMs: number, signal: AbortSignal): Promise<void>
}

function observeConditionNavigation(contents: WebContents, controller: AbortController) {
  const observation = { changed: false, dispose }
  const navigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (event.isMainFrame && !event.isSameDocument) observation.changed = true
  }
  const destroyed = () =>
    controller.abort(new Error('Embedded browser closed during condition wait'))
  contents.on('did-start-navigation', navigation)
  contents.once('destroyed', destroyed)
  function dispose() {
    contents.off('did-start-navigation', navigation)
    contents.off('destroyed', destroyed)
  }
  return observation
}

export function createBrowserConditionEvaluator(
  target: ConditionTarget
): BrowserConditionEvaluator {
  const assertCurrent = () => {
    if (!target.isCurrent() || target.contents.isDestroyed()) {
      throw new Error('Embedded browser closed or replaced during condition wait')
    }
  }
  return async (expression, remainingMs) => {
    assertCurrent()
    const deadline = Date.now() + remainingMs
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new BrowserConditionTimeoutError()),
      remainingMs
    )
    const navigation = observeConditionNavigation(target.contents, controller)
    const assertActive = () => {
      assertCurrent()
      controller.signal.throwIfAborted()
      if (Date.now() >= deadline) throw new BrowserConditionTimeoutError()
    }
    const waitForNavigation = async () => {
      assertActive()
      await target.waitForNavigation(Math.max(0, deadline - Date.now()), controller.signal)
      assertActive()
    }
    try {
      await waitForNavigation()
      navigation.changed = false
      let value: unknown
      try {
        // The condition script returns synchronously; only its observation is repeated.
        value = await evaluateScript(target.contents, expression, {
          awaitPromise: false,
          signal: controller.signal,
        })
      } catch (error) {
        assertCurrent()
        if (!(error instanceof EvaluationTransportError)) throw error
        if (!navigation.changed) throw error.cause
      }
      assertActive()
      if (!navigation.changed) return { kind: 'value', value }
      await waitForNavigation()
      return { kind: 'document-changed' }
    } catch (error) {
      controller.signal.throwIfAborted()
      throw error
    } finally {
      clearTimeout(timer)
      navigation.dispose()
    }
  }
}
