import { e2eErrorLog } from './e2e-error-log.js'
import type { WebContents } from 'electron'
import { describe, expect, test, vi } from 'vitest'
import { sendE2EKey, sendE2EText } from './e2e-keyboard.js'

const environment = {
  WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234',
  VITE_WEWORK_E2E: 'true',
}

function fixture() {
  const executeJavaScript = vi.fn()
  const view = {
    isDestroyed: () => false,
    isFocused: vi.fn(() => false),
    focus: vi.fn(),
    insertText: vi.fn(),
    executeJavaScript,
    focusedFrame: { executeJavaScript },
    sendInputEvent: vi.fn(),
  }
  return { view, contents: view as unknown as WebContents, focusWindow: vi.fn() }
}

describe('isolated native keyboard verification', () => {
  test.each(['key', 'text'])('preserves an already focused editor for %s input', async kind => {
    const { view, contents, focusWindow } = fixture()
    view.isFocused.mockReturnValue(true)

    if (kind === 'key') await sendE2EKey(contents, 'Meta+Shift+B', focusWindow, environment)
    else await sendE2EText(contents, 'editor text', focusWindow, environment)

    expect(focusWindow).not.toHaveBeenCalled()
    expect(view.focus).not.toHaveBeenCalled()
    if (kind === 'key') {
      expect(view.sendInputEvent.mock.calls).toEqual([
        [{ type: 'keyDown', keyCode: 'B', modifiers: ['meta', 'shift'] }],
        [{ type: 'keyUp', keyCode: 'B', modifiers: ['meta', 'shift'] }],
      ])
    } else expect(view.insertText).toHaveBeenCalledWith('editor text')
  })

  test('waits for window activation before sending native input', async () => {
    const { view, contents } = fixture()
    let activate!: () => void
    const activated = new Promise<void>(resolve => {
      activate = resolve
    })
    const input = sendE2EKey(contents, 'Enter', () => activated, environment)
    expect(view.sendInputEvent).not.toHaveBeenCalled()
    activate()
    await input
    expect(view.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode: 'Enter', modifiers: [] }],
      [{ type: 'char', keyCode: '\r', modifiers: [] }],
      [{ type: 'keyUp', keyCode: 'Enter', modifiers: [] }],
    ])
  })

  test('sends real shifted Tab events to the selected view', async () => {
    const { view, contents, focusWindow } = fixture()
    expect(await sendE2EKey(contents, 'Shift+Tab', focusWindow, environment)).toEqual({
      backend: 'electron-send-input-event',
      key: 'Shift+Tab',
      phase: 'press',
    })
    expect(focusWindow).toHaveBeenCalledOnce()
    expect(view.focus).toHaveBeenCalledOnce()
    expect(view.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] }],
      [{ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] }],
    ])
  })

  test('keeps native Space pressed until a matching key-up event', async () => {
    const { view, contents, focusWindow } = fixture()
    await sendE2EKey(contents, 'Space', focusWindow, environment, 'down')
    await sendE2EKey(contents, 'Space', focusWindow, environment, 'up')
    expect(view.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode: 'Space', modifiers: [] }],
      [{ type: 'keyUp', keyCode: 'Space', modifiers: [] }],
    ])
  })

  test('sends Space as a native key sequence including its character event', async () => {
    const { view, contents, focusWindow } = fixture()
    await sendE2EKey(contents, 'Space', focusWindow, environment)
    expect(view.sendInputEvent.mock.calls.map(([event]) => event.type)).toEqual([
      'keyDown',
      'char',
      'keyUp',
    ])
  })

  test.each([
    ['Meta+A', 'A', ['meta']],
    ['Control+A', 'A', ['control']],
    ['Backspace', 'Backspace', []],
    ['Meta+z', 'Z', ['meta']],
    ['Control+z', 'Z', ['control']],
    ['Meta+Shift+z', 'Z', ['meta', 'shift']],
    ['Control+Shift+z', 'Z', ['control', 'shift']],
    ['Meta+B', 'B', ['meta']],
    ['Meta+C', 'C', ['meta']],
    ['Control+B', 'B', ['control']],
    ['Meta+Alt+B', 'B', ['meta', 'alt']],
    ['Meta+Alt+F', 'F', ['meta', 'alt']],
    ['Meta+Alt+R', 'R', ['meta', 'alt']],
    ['Meta+Alt+S', 'S', ['meta', 'alt']],
    ['Control+Alt+F', 'F', ['control', 'alt']],
    ['Control+Alt+R', 'R', ['control', 'alt']],
    ['Control+Alt+S', 'S', ['control', 'alt']],
    ['Control+Shift+M', 'M', ['control', 'shift']],
    ['Shift+PageUp', 'PageUp', ['shift']],
    ['Shift+PageDown', 'PageDown', ['shift']],
    ['Home', 'Home', []],
    ['End', 'End', []],
    ['Shift+Home', 'Home', ['shift']],
    ['Shift+End', 'End', ['shift']],
    ['Meta+W', 'W', ['meta']],
  ])('sends native shortcut %s without inserting a character', async (key, keyCode, modifiers) => {
    const { view, contents, focusWindow } = fixture()
    await sendE2EKey(contents, key as string, focusWindow, environment)
    expect(view.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode, modifiers }],
      [{ type: 'keyUp', keyCode, modifiers }],
    ])
  })

  test('can send native input without re-focusing the window', async () => {
    const { view, contents, focusWindow } = fixture()
    await sendE2EKey(contents, 'Enter', focusWindow, environment, 'press', false)
    expect(focusWindow).not.toHaveBeenCalled()
    expect(view.focus).not.toHaveBeenCalled()
    expect(view.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode: 'Enter', modifiers: [] }],
      [{ type: 'char', keyCode: '\r', modifiers: [] }],
      [{ type: 'keyUp', keyCode: 'Enter', modifiers: [] }],
    ])
  })

  test('inserts ordinary text through a native character event', async () => {
    const { view, contents, focusWindow } = fixture()
    await sendE2EKey(contents, 'x', focusWindow, environment)
    expect(view.sendInputEvent.mock.calls).toContainEqual([
      { type: 'char', keyCode: 'x', modifiers: [] },
    ])
  })

  test('inserts text through the focused native editor', async () => {
    const { view, contents, focusWindow } = fixture()
    await expect(sendE2EText(contents, '第一行', focusWindow, environment)).resolves.toEqual({
      backend: 'electron-insert-text',
      textLength: 3,
    })
    expect(focusWindow).toHaveBeenCalledOnce()
    expect(view.focus).toHaveBeenCalledOnce()
    expect(view.insertText).toHaveBeenCalledWith('第一行')
  })

  test('waits for native insertion and propagates its failure', async () => {
    const { view, contents, focusWindow } = fixture()
    let fail!: (error: Error) => void
    view.insertText.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        fail = reject
      })
    )
    const settled = vi.fn()
    const insertion = sendE2EText(contents, 'text', focusWindow, environment)
    void insertion.then(settled, settled)
    await vi.waitFor(() => expect(view.insertText).toHaveBeenCalledWith('text'))
    expect(settled).not.toHaveBeenCalled()
    fail(new Error('Native insertion failed'))
    await expect(insertion).rejects.toThrow('Native insertion failed')
  })

  test('batches multiline native input while retaining empty and trailing paragraphs', async () => {
    const { view, contents, focusWindow } = fixture()
    view.isFocused.mockReturnValue(true)
    const events: string[] = []
    view.insertText.mockImplementation(async text => {
      events.push(`text:${text}`)
    })
    view.sendInputEvent.mockImplementation(event => {
      if (event.type === 'keyDown') events.push(`key:${event.keyCode}`)
    })

    await sendE2EText(contents, '\r\nfirst\r\n\rsecond\n', focusWindow, environment)

    expect(events).toEqual([
      'key:Enter',
      'text:first',
      'key:Enter',
      'key:Enter',
      'text:second',
      'key:Enter',
    ])
    expect(focusWindow).not.toHaveBeenCalled()
  })

  test('stops a native batch at the original insertion failure', async () => {
    const { view, contents, focusWindow } = fixture()
    view.insertText.mockRejectedValueOnce(new Error('Native insertion failed'))

    await expect(sendE2EText(contents, 'first\nsecond', focusWindow, environment)).rejects.toThrow(
      'Native insertion failed'
    )
    expect(view.insertText).toHaveBeenCalledExactlyOnceWith('first')
    expect(view.sendInputEvent).not.toHaveBeenCalled()
  })

  test('installs native acknowledgements before delivering input', async () => {
    const { view, contents, focusWindow } = fixture()
    let commit!: () => void
    view.executeJavaScript.mockReturnValueOnce(
      new Promise<void>(resolve => {
        commit = resolve
      })
    )
    const insertion = sendE2EText(contents, 'first\nsecond', focusWindow, environment)
    await vi.waitFor(() => expect(view.executeJavaScript).toHaveBeenCalledOnce())
    expect(view.insertText).not.toHaveBeenCalled()
    expect(view.sendInputEvent).not.toHaveBeenCalled()
    commit()
    await insertion
    expect(view.insertText.mock.calls).toEqual([['first'], ['second']])
    expect(view.executeJavaScript).toHaveBeenCalledTimes(3)
  })

  test('commits native Enter before inserting the following paragraph', async () => {
    const { view, contents, focusWindow } = fixture()
    let commitEnter!: () => void
    view.executeJavaScript.mockResolvedValueOnce(undefined).mockReturnValueOnce(
      new Promise<void>(resolve => {
        commitEnter = resolve
      })
    )
    const insertion = sendE2EText(contents, 'first\nsecond', focusWindow, environment)
    try {
      await vi.waitFor(() => expect(view.executeJavaScript).toHaveBeenCalledTimes(2))
      expect(view.sendInputEvent).toHaveBeenCalled()
      expect(view.insertText.mock.calls).toEqual([['first']])
    } finally {
      commitEnter()
      await insertion
    }
    expect(view.insertText.mock.calls).toEqual([['first'], ['second']])
  })

  test.each([{}, { WEWORK_E2E_CONTROL_URL: environment.WEWORK_E2E_CONTROL_URL }])(
    'rejects input without both isolated controller signals',
    async value => {
      const { view, contents, focusWindow } = fixture()
      await expect(sendE2EKey(contents, 'Enter', focusWindow, value)).rejects.toThrow(
        'An isolated E2E controller is required'
      )
      expect(focusWindow).not.toHaveBeenCalled()
      expect(view.sendInputEvent).not.toHaveBeenCalled()
    }
  )

  test.each(['Meta+Q', 'Control+Q', 'constructor', 'text', 'Unknown+B'])(
    'rejects unsupported key %s',
    async key => {
      const { view, contents, focusWindow } = fixture()
      await expect(sendE2EKey(contents, key, focusWindow, environment)).rejects.toThrow(
        'Unsupported verification key'
      )
      expect(view.sendInputEvent).not.toHaveBeenCalled()
      expect(focusWindow).not.toHaveBeenCalled()
    }
  )
})

test('records each native input phase without recording text content', async () => {
  const { view, contents, focusWindow } = fixture()
  let clock = 0
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const journal = vi.spyOn(e2eErrorLog, 'record').mockImplementation(() => undefined)
  view.insertText.mockImplementation(async () => {
    clock += 5
  })
  view.executeJavaScript.mockImplementation(async () => {
    clock += 20
  })
  try {
    await sendE2EText(contents, 'synthetic-secret\nsecond', focusWindow, environment)
    const stopped = journal.mock.calls.find(call => call[1] === 'native-text-stopped')
    expect(stopped?.[3]).toMatchObject({
      completedLines: 2,
      lineCount: 2,
      enterCommitCount: 1,
      enterCommitWaitMs: 20,
      commitSetupMs: 20,
      commitCleanupMs: 20,
      insertTextMs: 10,
      elapsedMs: 70,
    })
    expect(journal.mock.calls.filter(call => call[1] === 'native-text-progress')).toHaveLength(2)
    expect(JSON.stringify(journal.mock.calls)).not.toContain('synthetic-secret')
  } finally {
    journal.mockRestore()
    now.mockRestore()
  }
})

test('retains native input timing and the original insertion failure', async () => {
  const { view, contents, focusWindow } = fixture()
  const error = new Error('native insertion rejected')
  view.insertText.mockRejectedValueOnce(error)
  const journal = vi.spyOn(e2eErrorLog, 'record').mockImplementation(() => undefined)
  try {
    await expect(sendE2EText(contents, 'first\nsecond', focusWindow, environment)).rejects.toBe(
      error
    )
    expect(journal.mock.calls.find(call => call[1] === 'native-text-stopped')?.[3]).toMatchObject({
      completedLines: 0,
      lineCount: 2,
      enterCommitCount: 0,
    })
  } finally {
    journal.mockRestore()
  }
})

test('does not deliver text when the native acknowledgement cannot be installed', async () => {
  const { view, contents, focusWindow } = fixture()
  const error = new Error('Native target setup failed')
  view.executeJavaScript.mockRejectedValueOnce(error)
  await expect(sendE2EText(contents, 'first\nsecond', focusWindow, environment)).rejects.toBe(error)
  expect(view.insertText).not.toHaveBeenCalled()
  expect(view.sendInputEvent).not.toHaveBeenCalled()
})

test.each([true, false])(
  'retains failures when native listener cleanup fails: input failed=%s',
  async inputFailed => {
    const { view, contents, focusWindow } = fixture()
    const insertionError = new Error('Native insertion failed')
    const cleanupError = new Error('Native cleanup failed')
    view.executeJavaScript.mockResolvedValueOnce(undefined)
    if (inputFailed) view.insertText.mockRejectedValueOnce(insertionError)
    else view.executeJavaScript.mockResolvedValueOnce(undefined)
    view.executeJavaScript.mockRejectedValueOnce(cleanupError)
    const journal = vi.spyOn(e2eErrorLog, 'record').mockImplementation(() => undefined)
    try {
      await expect(sendE2EText(contents, 'first\nsecond', focusWindow, environment)).rejects.toBe(
        inputFailed ? insertionError : cleanupError
      )
      expect(journal.mock.calls).toContainEqual([
        'main',
        'native-text-cleanup-failed',
        'error',
        expect.objectContaining({ message: cleanupError.message }),
      ])
      expect(journal.mock.calls.some(call => call[1] === 'native-text-stopped')).toBe(true)
    } finally {
      journal.mockRestore()
    }
  }
)
