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
