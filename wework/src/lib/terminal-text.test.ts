import { describe, expect, test } from 'vitest'
import { terminalOutputToText } from './terminal-text'

describe('terminalOutputToText', () => {
  test('collapses spinner frames that return to and clear the current line', () => {
    const output = '\u001b[1G\u001b[0K⠙\u001b[1G\u001b[0K⠹\u001b[1G\u001b[0Kadded 703 packages\n'

    expect(terminalOutputToText(output)).toBe('added 703 packages\n')
  })

  test('applies carriage returns and cursor-relative overwrites', () => {
    expect(terminalOutputToText('progress 10%\rprogress 20%\u001b[2D5')).toBe('progress 25%')
  })

  test('removes color and terminal-title sequences', () => {
    const output = '\u001b]0;npm install\u0007\u001b[32msuccess\u001b[0m'

    expect(terminalOutputToText(output)).toBe('success')
  })

  test('keeps the cursor position when the whole line is erased', () => {
    expect(terminalOutputToText('abc\u001b[2Kx')).toBe('   x')
  })
})
