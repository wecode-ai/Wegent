import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, test, vi } from 'vitest'
import { captureProcessExplorerWindowSnapshot } from './process-explorer-window-snapshot.js'

const CONTENTS = {
  url: 'http://localhost/wework/app/process-explorer',
  windowLabel: 'process-explorer',
  testIds: ['process-explorer-window', 'process-explorer-row-42'],
  text: 'CPU 1.5% Uptime 10s',
  layout: { viewportWidth: 720, tableClientWidth: 700, tableScrollWidth: 700 },
}

function fixture() {
  let windowDestroyed = false
  let contentsDestroyed = false
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => contentsDestroyed,
    executeJavaScript: vi.fn<() => Promise<typeof CONTENTS>>().mockResolvedValue(CONTENTS),
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => windowDestroyed,
    getBounds: vi.fn(() => ({ width: 720, height: 640 })),
    isVisible: () => true,
    isAlwaysOnTop: () => false,
    isMenuBarVisible: () => false,
  })
  return {
    window,
    contents,
    target: window as unknown as BrowserWindow,
    close: () => {
      windowDestroyed = true
      window.emit('closed')
    },
    destroyContents: () => {
      contentsDestroyed = true
      contents.emit('destroyed')
    },
  }
}

function expectNoListeners(f: ReturnType<typeof fixture>) {
  expect(f.window.listenerCount('closed')).toBe(0)
  expect(f.contents.listenerCount('destroyed')).toBe(0)
}

describe('captureProcessExplorerWindowSnapshot', () => {
  test('captures live contents after registering both lifecycle listeners and cleans them up', async () => {
    const f = fixture()
    f.contents.executeJavaScript.mockImplementation(async () => {
      expect(f.window.listenerCount('closed')).toBe(1)
      expect(f.contents.listenerCount('destroyed')).toBe(1)
      return CONTENTS
    })

    expect(await captureProcessExplorerWindowSnapshot(f.target, 42)).toEqual({
      ...CONTENTS,
      exists: true,
      visible: true,
      applicationPid: 42,
      windowWidth: 720,
      windowHeight: 640,
      alwaysOnTop: false,
      menuBarVisible: false,
    })
    expectNoListeners(f)
  })

  test('reports a missing window without executing renderer code', async () => {
    expect(await captureProcessExplorerWindowSnapshot(null, 42)).toMatchObject({
      exists: false,
      applicationPid: 42,
      testIds: [],
    })
  })

  test.each(['close', 'destroyContents'] as const)(
    'does not execute renderer code after %s',
    async lifecycle => {
      const f = fixture()
      f[lifecycle]()

      expect(await captureProcessExplorerWindowSnapshot(f.target, 42)).toMatchObject({
        exists: false,
      })
      expect(f.contents.executeJavaScript).not.toHaveBeenCalled()
      expectNoListeners(f)
    }
  )

  test.each(['close', 'destroyContents'] as const)(
    'settles an abandoned renderer script when %s occurs',
    async lifecycle => {
      const f = fixture()
      f.contents.executeJavaScript.mockReturnValue(new Promise(() => {}))
      const snapshot = captureProcessExplorerWindowSnapshot(f.target, 42)

      f[lifecycle]()

      expect(await snapshot).toMatchObject({ exists: false, applicationPid: 42 })
      expect(f.window.getBounds).not.toHaveBeenCalled()
      expectNoListeners(f)
    }
  )

  test('cleans up listeners and preserves a live renderer rejection', async () => {
    const f = fixture()
    const error = new Error('Renderer script failed')
    f.contents.executeJavaScript.mockRejectedValue(error)

    await expect(captureProcessExplorerWindowSnapshot(f.target, 42)).rejects.toBe(error)
    expectNoListeners(f)
  })

  test('cleans up listeners and preserves a synchronous live renderer error', async () => {
    const f = fixture()
    const error = new Error('Renderer execution failed')
    f.contents.executeJavaScript.mockImplementation(() => {
      throw error
    })

    await expect(captureProcessExplorerWindowSnapshot(f.target, 42)).rejects.toBe(error)
    expectNoListeners(f)
  })

  test('treats a synchronous close during script submission as normal window removal', async () => {
    const f = fixture()
    f.contents.executeJavaScript.mockImplementation(() => {
      f.close()
      throw new Error('Object has been destroyed')
    })

    expect(await captureProcessExplorerWindowSnapshot(f.target, 42)).toMatchObject({
      exists: false,
    })
    expectNoListeners(f)
  })

  test('does not read native window properties if it closes after the DOM response', async () => {
    const f = fixture()
    const snapshot = captureProcessExplorerWindowSnapshot(f.target, 42)
    f.close()

    expect(await snapshot).toMatchObject({ exists: false })
    expect(f.window.getBounds).not.toHaveBeenCalled()
    expectNoListeners(f)
  })

  test('handles a late renderer rejection after the closed result has already settled', async () => {
    const f = fixture()
    let rejectScript!: (reason: Error) => void
    f.contents.executeJavaScript.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectScript = reject
      })
    )
    const snapshot = captureProcessExplorerWindowSnapshot(f.target, 42)
    f.close()
    expect(await snapshot).toMatchObject({ exists: false })

    rejectScript(new Error('Renderer disappeared'))
    await Promise.resolve()

    expectNoListeners(f)
    expect(f.window.getBounds).not.toHaveBeenCalled()
  })

  test('discards a late successful script result after the window has closed', async () => {
    const f = fixture()
    let finishScript!: (value: typeof CONTENTS) => void
    f.contents.executeJavaScript.mockReturnValue(
      new Promise(resolve => {
        finishScript = resolve
      })
    )
    const snapshot = captureProcessExplorerWindowSnapshot(f.target, 42)
    f.close()
    expect(await snapshot).toMatchObject({ exists: false })

    finishScript(CONTENTS)
    await Promise.resolve()

    expectNoListeners(f)
    expect(f.window.getBounds).not.toHaveBeenCalled()
  })
})
