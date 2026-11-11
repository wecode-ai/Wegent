import { describe, expect, it, vi } from 'vitest'
import { evaluateWorkbenchPage } from './e2e-workbench-page.js'

function fixture({ lightweight = true, destroyed = false, detached = false } = {}) {
  const sandbox = {
    name: 'wework-workbench-lightweight',
    detached,
    isDestroyed: () => destroyed,
    executeJavaScript: vi.fn(async () => 'preserved sandbox input'),
  }
  const main = {
    frames: lightweight ? [sandbox] : [],
    detached: false,
    isDestroyed: () => false,
    executeJavaScript: vi.fn(async () => 'preserved extended input'),
  }
  return { contents: { mainFrame: main } as never, main, sandbox }
}

describe('workbench page controls', () => {
  it('executes in the native sandbox frame even when its document belongs to another renderer process', async () => {
    const { contents, main, sandbox } = fixture()
    await expect(evaluateWorkbenchPage(contents, 'document.body.textContent')).resolves.toBe(
      'preserved sandbox input'
    )
    expect(sandbox.executeJavaScript).toHaveBeenCalledWith('(document.body.textContent)', true)
    expect(main.executeJavaScript).not.toHaveBeenCalled()
  })

  it('uses the extended application document when no lightweight frame exists', async () => {
    const { contents, main } = fixture({ lightweight: false })
    await expect(evaluateWorkbenchPage(contents, 'document.title')).resolves.toBe(
      'preserved extended input'
    )
    expect(main.executeJavaScript).toHaveBeenCalledWith('(document.title)', true)
  })

  it.each([{ destroyed: true }, { detached: true }])(
    'rejects a frame removed during control: %j',
    async state => {
      const { contents, sandbox } = fixture(state)
      await expect(evaluateWorkbenchPage(contents, 'document.title')).rejects.toThrow(
        'no longer available'
      )
      expect(sandbox.executeJavaScript).not.toHaveBeenCalled()
    }
  )

  it('propagates an actual page operation failure', async () => {
    const { contents, sandbox } = fixture()
    sandbox.executeJavaScript.mockRejectedValueOnce(new Error('Page operation failed'))
    await expect(evaluateWorkbenchPage(contents, 'missingOperation()')).rejects.toThrow(
      'Page operation failed'
    )
  })
})
