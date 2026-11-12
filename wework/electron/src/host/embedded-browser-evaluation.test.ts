import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { expect, test } from 'vitest'
import { FakeWebContents } from '../../test-fixtures/embedded-browser.js'
import { EmbeddedBrowserManager } from './embedded-browser-manager.js'

test.each([false, true])(
  'evaluates a background page with an existing inspector: %s',
  async attached => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-evaluation-'))
    const contents = new FakeWebContents()
    let connected = attached
    contents.debugger.isAttached.mockImplementation(() => connected)
    contents.debugger.attach.mockImplementation(() => {
      connected = true
    })
    contents.debugger.detach.mockImplementation(() => {
      connected = false
    })
    const manager = new EmbeddedBrowserManager(directory, () => {})
    manager.attach('background', contents as unknown as WebContents)
    await manager.open({
      label: 'background',
      url: 'about:blank',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: false,
      navigateExisting: false,
    })
    try {
      contents.debugger.sendCommand.mockResolvedValue({ result: { value: { answer: 42 } } })
      expect(await manager.evaluate('background', 'Promise.resolve({answer:42})')).toEqual({
        answer: 42,
      })
      expect(contents.debugger.sendCommand).toHaveBeenCalledExactlyOnceWith('Runtime.evaluate', {
        expression: 'Promise.resolve({answer:42})',
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      })
      expect(contents.executeJavaScript).not.toHaveBeenCalled()
      expect(contents.debugger.detach).toHaveBeenCalledTimes(attached ? 0 : 1)
      contents.debugger.sendCommand.mockResolvedValue({
        exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: rejected' } },
      })
      await expect(
        manager.evaluate('background', 'Promise.reject(new Error("rejected"))')
      ).rejects.toThrow('Error: rejected')
      expect(contents.debugger.detach).toHaveBeenCalledTimes(attached ? 0 : 2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test('returns a synchronous action result before navigation destroys promise callbacks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-browser-action-evaluation-'))
  const contents = new FakeWebContents()
  const manager = new EmbeddedBrowserManager(directory)
  manager.attach('browser', contents as unknown as WebContents)
  await manager.open({
    label: 'browser',
    url: 'about:blank',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    visible: false,
    navigateExisting: false,
  })
  let clicks = 0
  contents.debugger.sendCommand.mockImplementation(async (_method, options) => {
    clicks++
    if (options.awaitPromise) throw new Error('Inspected target navigated or closed')
    return { result: { value: { ok: true, action: 'click' } } }
  })
  try {
    await expect(
      manager.evaluate('browser', 'document.querySelector("a").click()', {
        awaitPromise: false,
      })
    ).resolves.toEqual({ ok: true, action: 'click' })
    expect(clicks).toBe(1)
    expect(contents.executeJavaScript).not.toHaveBeenCalled()

    contents.debugger.sendCommand.mockRejectedValue(new Error('Page closed before dispatch'))
    await expect(
      manager.evaluate('browser', 'document.querySelector("a").click()', {
        awaitPromise: false,
      })
    ).rejects.toThrow('Page closed before dispatch')
  } finally {
    manager.close('browser')
    await rm(directory, { recursive: true, force: true })
  }
})
