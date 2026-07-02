import { describe, expect, test, vi } from 'vitest'
import { installXtermInputFallback } from './xtermInputFallback'

function dispatchTextInput(textarea: HTMLTextAreaElement, data: string) {
  textarea.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data,
    })
  )
}

describe('installXtermInputFallback', () => {
  test('fills in the missing tail when xterm only emits part of inserted text', () => {
    const textarea = document.createElement('textarea')
    const writeData = vi.fn()
    const fallback = installXtermInputFallback({
      terminal: { textarea },
      writeData,
    })

    fallback.noteData('pw')
    dispatchTextInput(textarea, 'pwd')

    expect(writeData).toHaveBeenCalledWith('d')
  })

  test('does not duplicate input that xterm already emitted', () => {
    const textarea = document.createElement('textarea')
    const writeData = vi.fn()
    const fallback = installXtermInputFallback({
      terminal: { textarea },
      writeData,
    })

    fallback.noteData('pwd')
    dispatchTextInput(textarea, 'pwd')

    expect(writeData).not.toHaveBeenCalled()
  })

  test('forwards inserted text when xterm emitted nothing', () => {
    const textarea = document.createElement('textarea')
    const writeData = vi.fn()
    installXtermInputFallback({
      terminal: { textarea },
      writeData,
    })

    dispatchTextInput(textarea, 'pwd')

    expect(writeData).toHaveBeenCalledWith('pwd')
  })

  test('ignores delete input events', () => {
    const textarea = document.createElement('textarea')
    const writeData = vi.fn()
    const fallback = installXtermInputFallback({
      terminal: { textarea },
      writeData,
    })

    fallback.noteData('pwd')
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'deleteContentBackward',
      })
    )

    expect(writeData).not.toHaveBeenCalled()
  })

  test('detaches the textarea listener on dispose', () => {
    const textarea = document.createElement('textarea')
    const writeData = vi.fn()
    const fallback = installXtermInputFallback({
      terminal: { textarea },
      writeData,
    })

    fallback.dispose()
    dispatchTextInput(textarea, 'pwd')

    expect(writeData).not.toHaveBeenCalled()
  })
})
