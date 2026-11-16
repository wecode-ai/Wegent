import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WebContents } from 'electron'
import { expect, test, vi } from 'vitest'
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

test.each([false, true, 'later-link'] as const)(
  'a local preview action preserves its reply and newer navigation: override=%s',
  async override => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-action-navigation-'))
    const nested = join(directory, 'nested')
    await mkdir(nested)
    const later = join(directory, 'later')
    await mkdir(later)
    const contents = new FakeWebContents()
    const manager = new EmbeddedBrowserManager(directory)
    const reply = Promise.withResolvers<unknown>()
    let actionPending = false
    contents.loadURL.mockImplementation(async url => {
      if (actionPending) reply.reject(new Error('Inspected target navigated or closed'))
      contents.commitUrl(url)
      contents.emit('did-navigate', {}, url)
    })
    manager.attach('browser', contents as unknown as WebContents)
    try {
      await manager.open({
        label: 'browser',
        url: pathToFileURL(directory).href,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visible: true,
        navigateExisting: true,
      })
      const destination = `${pathToFileURL(nested).href}/`
      const event = { preventDefault() {} }
      contents.debugger.sendCommand.mockImplementation(() => {
        actionPending = true
        contents.emit('will-navigate', event, destination)
        if (override === 'later-link')
          contents.emit('will-navigate', event, `${pathToFileURL(later).href}/`)
        return reply.promise
      })
      const result = manager
        .evaluate('browser', 'document.querySelector("a").click()', {
          awaitPromise: false,
        })
        .then(
          value => ({ value }),
          error => ({ error: String(error) })
        )
      // The action remains pending throughout this negative observation window.
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(contents.loadURL).toHaveBeenCalledOnce()
      actionPending = false
      const newerUrl = 'https://example.com/newer'
      if (override === true) await manager.navigate('browser', newerUrl)
      reply.resolve({ result: { value: { ok: true } } })
      await expect(result).resolves.toEqual({ value: { ok: true } })
      if (override === true) {
        // An older queued link must not replace a navigation explicitly started later.
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(contents.loadURL).toHaveBeenCalledTimes(2)
        expect(manager.state('browser').url).toBe(newerUrl)
      } else {
        await vi.waitFor(() => {
          expect(contents.loadURL).toHaveBeenCalledTimes(2)
          expect(manager.state('browser').url).toBe(
            override === 'later-link' ? `${pathToFileURL(later).href}/` : destination
          )
        })
      }
    } finally {
      reply.resolve({ result: { value: { ok: true } } })
      manager.close('browser')
      await rm(directory, { recursive: true, force: true })
    }
  }
)
