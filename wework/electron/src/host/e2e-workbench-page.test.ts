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
  const contents = {
    mainFrame: main,
    executeJavaScript: vi.fn(async () => 'preserved extended input'),
  }
  return { contents: contents as never, main, sandbox, execute: contents.executeJavaScript }
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
    const { contents, main, execute } = fixture({ lightweight: false })
    await expect(evaluateWorkbenchPage(contents, 'document.title')).resolves.toBe(
      'preserved extended input'
    )
    expect(execute).toHaveBeenCalledWith('(document.title)', true)
    expect(main.executeJavaScript).not.toHaveBeenCalled()
  })

  it('waits for the WebContents-managed extended page load without addressing its initial frame', async () => {
    const { contents, main, execute } = fixture({ lightweight: false })
    let finishLoading!: () => void
    execute.mockImplementation(
      () => new Promise(resolve => (finishLoading = () => resolve('loaded extended document')))
    )
    main.executeJavaScript.mockImplementation(() => new Promise<string>(() => {}))
    let completed = false
    const result = evaluateWorkbenchPage(contents, 'document.body.textContent').then(value => {
      completed = true
      return value
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(execute).toHaveBeenCalledWith('(document.body.textContent)', true)
    expect(main.executeJavaScript).not.toHaveBeenCalled()
    finishLoading()
    await expect(result).resolves.toBe('loaded extended document')
  })

  it('propagates an extended WebContents operation failure', async () => {
    const { contents, execute } = fixture({ lightweight: false })
    execute.mockRejectedValueOnce(new Error('Extended page operation failed'))
    await expect(evaluateWorkbenchPage(contents, 'missingOperation()')).rejects.toThrow(
      'Extended page operation failed'
    )
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
