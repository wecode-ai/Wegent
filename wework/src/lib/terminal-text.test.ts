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

  test('applies vertical cursor movement while preserving the column', () => {
    expect(terminalOutputToText('old\nnew\u001b[1A\rNEW')).toBe('NEW\nnew')
  })

  test('bounds cursor-controlled padding', () => {
    const output = terminalOutputToText('\u001b[999999999Cx')

    expect(output).toHaveLength(4_096)
    expect(output.endsWith('x')).toBe(true)
  })

  test('bounds total rendered cells across lines', () => {
    const input = Array.from({ length: 200 }, () => '\u001b[999999999Gx').join('\n')

    expect(terminalOutputToText(input).length).toBeLessThanOrEqual(32_768 + 199)
  })

  test('bounds a large uninterrupted output line', () => {
    expect(terminalOutputToText('x'.repeat(1_000_000))).toHaveLength(4_096)
  })

  test('keeps the latest terminal scrollback lines', () => {
    const input = Array.from({ length: 201 }, (_, index) => `line ${index}`).join('\n')
    const lines = terminalOutputToText(input).split('\n')

    expect(lines).toHaveLength(200)
    expect(lines[0]).toBe('line 1')
    expect(lines.at(-1)).toBe('line 200')
  })
})
