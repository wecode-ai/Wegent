import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { WebContents } from 'electron'
import { afterEach, expect, test, vi } from 'vitest'
import { FakeWebContents } from '../../test-fixtures/embedded-browser.js'
import { EmbeddedBrowserBridge } from './embedded-browser-bridge.js'
import { EmbeddedBrowserManager } from './embedded-browser-manager.js'

const fixtures: Array<{ directory: string; manager: EmbeddedBrowserManager }> = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.manager.close('browser')
    await rm(fixture.directory, { recursive: true, force: true })
  }
  vi.useRealTimers()
})

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => (release = resolve))
  return { promise, release }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'wework-browser-condition-'))
  const contents = new FakeWebContents()
  let debuggerAttached = false
  contents.debugger.isAttached.mockImplementation(() => debuggerAttached)
  contents.debugger.attach.mockImplementation(() => {
    debuggerAttached = true
  })
  contents.debugger.detach.mockImplementation(() => {
    debuggerAttached = false
  })
  const manager = new EmbeddedBrowserManager(directory)
  manager.attach('browser', contents as unknown as WebContents)
  await manager.open({
    label: 'browser',
    url: 'about:blank',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    visible: false,
    navigateExisting: false,
  })
  const bridge = new EmbeddedBrowserBridge(manager, directory)
  fixtures.push({ directory, manager })
  const run = (timeoutMs = 1_000) =>
    bridge['dispatchAction']('browser', 'browser', {
      action: 'waitFor',
      text: 'Current document',
      timeoutMs,
      options: { pollMs: 50 },
    })
  const listeners = new Map(contents.eventNames().map(name => [name, contents.listenerCount(name)]))
  const expectCleaned = () => {
    for (const name of new Set([...contents.eventNames(), ...listeners.keys()])) {
      expect(contents.listenerCount(name), String(name)).toBe(listeners.get(name) ?? 0)
    }
    expect(vi.getTimerCount()).toBe(0)
  }
  return { contents, manager, bridge, run, expectCleaned }
}

function navigation(app: Awaited<ReturnType<typeof fixture>>) {
  const started = barrier()
  const finish = barrier()
  app.contents.loadURL.mockImplementationOnce(async url => {
    app.contents.isLoadingMainFrame.mockReturnValue(true)
    app.contents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url,
    })
    started.release()
    await finish.promise
    app.contents.commitUrl(url)
    app.contents.isLoadingMainFrame.mockReturnValue(false)
    app.contents.emit('did-navigate', {}, url)
  })
  return { started, finish }
}

test('a navigation-invalidated condition waits for the new document without replaying its click', async () => {
  const app = await fixture()
  const next = navigation(app)
  const evaluationStarted = barrier()
  let actionCount = 0
  let predicateCount = 0
  app.contents.debugger.sendCommand.mockImplementation(async (_method, params) => {
    if (params.expression.includes('"action":"click"')) {
      actionCount += 1
      return { result: { value: { ok: true } } }
    }
    predicateCount += 1
    expect(params.awaitPromise).toBe(false)
    if (predicateCount === 1) {
      void app.manager.navigate('browser', 'https://next.test/').catch(() => undefined)
      await next.started.promise
      evaluationStarted.release()
      throw new Error('Inspected target navigated or closed')
    }
    expect(app.contents.getURL()).toBe('https://next.test/')
    return { result: { value: { ok: true, kind: 'browser.wait', currentDocument: true } } }
  })
  await app.bridge['runAction']('browser', {
    action: 'click',
    selector: '#parent-link',
    options: { riskApproved: true },
  })
  vi.useFakeTimers()
  const result = app.run().catch(error => error)
  await evaluationStarted.promise
  await vi.advanceTimersByTimeAsync(200)
  expect(predicateCount).toBe(1)
  expect(actionCount).toBe(1)
  next.finish.release()
  await expect(result).resolves.toMatchObject({ ok: true, currentDocument: true })
  expect(actionCount).toBe(1)
  expect(predicateCount).toBe(2)
  expect(app.contents.debugger.sendCommand).toHaveBeenCalledTimes(3)
  app.expectCleaned()
})

test.each(['stable', 'subframe', 'same-document'] as const)(
  'does not swallow a transport failure in a %s document',
  async kind => {
    const app = await fixture()
    const error = new Error('Inspected target navigated or closed')
    app.contents.debugger.sendCommand.mockImplementation(async () => {
      if (kind === 'subframe')
        app.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
      if (kind === 'same-document')
        app.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
      throw error
    })
    vi.useFakeTimers()
    await expect(app.run()).rejects.toBe(error)
    expect(app.contents.debugger.sendCommand).toHaveBeenCalledOnce()
    app.expectCleaned()
  }
)

test('preserves a page script exception even when main-frame navigation also starts', async () => {
  const app = await fixture()
  app.contents.debugger.sendCommand.mockImplementation(async () => {
    app.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    return {
      exceptionDetails: { text: 'Uncaught', exception: { description: 'Predicate failed' } },
    }
  })
  vi.useFakeTimers()
  await expect(app.run()).rejects.toThrow('Predicate failed')
  expect(app.contents.debugger.sendCommand).toHaveBeenCalledOnce()
  app.expectCleaned()
})

test.each(['destroy', 'replace'] as const)(
  'fails when the original guest is %sd during evaluation',
  async action => {
    const app = await fixture()
    app.contents.debugger.sendCommand.mockImplementation(async () => {
      app.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      if (action === 'destroy') app.contents.close()
      else app.manager.attach('browser', new FakeWebContents() as unknown as WebContents)
      throw new Error('Inspected target navigated or closed')
    })
    vi.useFakeTimers()
    await expect(app.run()).rejects.toThrow()
    expect(app.contents.debugger.sendCommand).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  }
)

test('navigation completion consumes the original wait deadline and removes observers', async () => {
  const app = await fixture()
  const next = navigation(app)
  const entered = barrier()
  app.contents.debugger.sendCommand.mockImplementation(async () => {
    void app.manager.navigate('browser', 'https://next.test/').catch(() => undefined)
    await next.started.promise
    entered.release()
    throw new Error('Inspected target navigated or closed')
  })
  vi.useFakeTimers()
  const result = app.run(300).catch(error => error)
  await entered.promise
  let settled = false
  void result.then(() => (settled = true))
  await vi.advanceTimersByTimeAsync(299)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await result).toMatchObject({ ok: false, error: { code: 'wait_timeout' } })
  expect(app.contents.debugger.sendCommand).toHaveBeenCalledOnce()
  app.expectCleaned()
  next.finish.release()
})

test('a pending condition command releases its debugger lease at the original deadline', async () => {
  const app = await fixture()
  const entered = barrier()
  app.contents.debugger.sendCommand.mockImplementation(() => {
    entered.release()
    return new Promise(() => undefined)
  })
  vi.useFakeTimers()
  const result = app.run(300).catch(error => error)
  await entered.promise
  await vi.advanceTimersByTimeAsync(300)
  expect(await result).toMatchObject({ ok: false, error: { code: 'wait_timeout' } })
  expect(app.contents.debugger.detach).toHaveBeenCalledOnce()
  app.expectCleaned()
})

test('an already loading document consumes the original deadline and cancels navigation polling', async () => {
  const app = await fixture()
  const entered = barrier()
  app.contents.isLoadingMainFrame.mockImplementation(() => {
    entered.release()
    return true
  })
  vi.useFakeTimers()
  const result = app.run(300).catch(error => error)
  await entered.promise
  await vi.advanceTimersByTimeAsync(300)
  expect(await result).toMatchObject({ ok: false, error: { code: 'wait_timeout' } })
  expect(app.contents.debugger.sendCommand).not.toHaveBeenCalled()
  app.expectCleaned()
})

test('a destroyed guest aborts a pending command without classifying it as navigation', async () => {
  const app = await fixture()
  const entered = barrier()
  app.contents.debugger.sendCommand.mockImplementation(() => {
    entered.release()
    return new Promise(() => undefined)
  })
  vi.useFakeTimers()
  const result = app.run().catch(error => error)
  await entered.promise
  app.contents.close()
  expect(await result).toBeInstanceOf(Error)
  expect(app.contents.debugger.detach).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  expect(app.contents.listenerCount('did-start-navigation')).toBe(1)
})

test('does not rebind a pending wait to a replacement guest between predicate polls', async () => {
  const app = await fixture()
  const entered = barrier()
  app.contents.debugger.sendCommand.mockImplementation(async () => {
    entered.release()
    return { result: { value: { ok: false, reason: 'text_visible' } } }
  })
  vi.useFakeTimers()
  const result = app.run().catch(error => error)
  await entered.promise
  await vi.advanceTimersByTimeAsync(0)
  const replacement = new FakeWebContents()
  app.manager.attach('browser', replacement as unknown as WebContents)
  await vi.advanceTimersByTimeAsync(50)
  expect(await result).toBeInstanceOf(Error)
  expect(app.contents.debugger.sendCommand).toHaveBeenCalledOnce()
  expect(replacement.debugger.sendCommand).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

test('binds the original guest before asynchronously loading the condition script', async () => {
  const app = await fixture()
  const entered = barrier()
  const finish = barrier()
  app.bridge['loadScript'] = async () => {
    entered.release()
    await finish.promise
    return 'condition-predicate'
  }
  vi.useFakeTimers()
  const result = app.run().catch(error => error)
  await entered.promise
  const replacement = new FakeWebContents()
  app.manager.attach('browser', replacement as unknown as WebContents)
  finish.release()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(await result).toBeInstanceOf(Error)
  expect(app.contents.debugger.sendCommand).not.toHaveBeenCalled()
  expect(replacement.debugger.sendCommand).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

test('discards a successful old-document result when its main frame starts navigating', async () => {
  const app = await fixture()
  const next = navigation(app)
  const entered = barrier()
  let predicateCount = 0
  app.contents.debugger.sendCommand.mockImplementation(async () => {
    predicateCount += 1
    if (predicateCount === 1) {
      void app.manager.navigate('browser', 'https://next.test/').catch(() => undefined)
      await next.started.promise
      entered.release()
      return { result: { value: { ok: true, currentDocument: false } } }
    }
    return { result: { value: { ok: true, currentDocument: true } } }
  })
  vi.useFakeTimers()
  const result = app.run().catch(error => error)
  await entered.promise
  let settled = false
  void result.then(() => (settled = true))
  await vi.advanceTimersByTimeAsync(100)
  expect(settled).toBe(false)
  next.finish.release()
  await expect(result).resolves.toMatchObject({ ok: true, currentDocument: true })
  expect(predicateCount).toBe(2)
  app.expectCleaned()
})

test('the real condition script returns a synchronous predicate result', async () => {
  const source = await readFile(
    new URL('./browser-runtime/embedded_browser_wait.js', import.meta.url),
    'utf8'
  )
  const result = runInNewContext(
    source.replace('__WEWORK_WAIT_INPUT__', JSON.stringify({ text: 'Current document' })),
    {
      window: { __WEWORK_BROWSER_AGENT__: { revisionObserverInstalled: true } },
      document: { title: '', readyState: 'complete', body: { innerText: 'Current document' } },
      location: { href: 'https://current.test/' },
      performance: { now: () => 0 },
    }
  )
  expect(result).toMatchObject({ ok: true, kind: 'browser.wait' })
  expect(result).not.toBeInstanceOf(Promise)
  expect(result?.then).toBeUndefined()
})
