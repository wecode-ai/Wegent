import type { WebContents } from 'electron'
import { expect, test } from 'vitest'
import { FakeWebContents } from '../../test-fixtures/embedded-browser.js'
import { BrowserScriptEvaluator } from './browser-script-evaluator.js'

test.each([undefined, true, false])(
  'only waits for synchronous actions before navigation: awaitPromise=%s',
  async awaitPromise => {
    const contents = new FakeWebContents()
    const response = Promise.withResolvers<unknown>()
    contents.debugger.sendCommand.mockImplementation(() => response.promise)
    const scripts = new BrowserScriptEvaluator(contents as unknown as WebContents)
    const evaluation = scripts.evaluate('testExpression', { awaitPromise })
    let navigated = false
    const navigation = scripts.afterActions(async () => {
      navigated = true
    })
    await Promise.resolve()
    expect(navigated).toBe(awaitPromise !== false)
    response.resolve({ result: { value: 'result' } })
    await expect(evaluation).resolves.toBe('result')
    await navigation
    expect(navigated).toBe(true)
  }
)
