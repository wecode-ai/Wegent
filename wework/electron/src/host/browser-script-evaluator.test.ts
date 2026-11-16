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

test('waits for synchronous actions started while navigation is already deferred', async () => {
  const contents = new FakeWebContents()
  const first = Promise.withResolvers<unknown>()
  const second = Promise.withResolvers<unknown>()
  contents.debugger.sendCommand
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
  const scripts = new BrowserScriptEvaluator(contents as unknown as WebContents)
  const firstAction = scripts.evaluate('first()', { awaitPromise: false })
  let navigated = false
  const navigation = scripts.afterActions(async () => {
    navigated = true
  })
  const secondAction = scripts.evaluate('second()', { awaitPromise: false })
  first.resolve({ result: { value: 'first' } })
  await firstAction
  // Keep the second action pending throughout this negative observation window.
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(navigated).toBe(false)
  second.resolve({ result: { value: 'second' } })
  await secondAction
  await navigation
  expect(navigated).toBe(true)
})
