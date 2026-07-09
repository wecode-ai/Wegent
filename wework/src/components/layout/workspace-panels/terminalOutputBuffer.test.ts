import { describe, expect, test } from 'vitest'
import {
  appendTerminalOutput,
  clearTerminalOutput,
  readTerminalOutput,
} from './terminalOutputBuffer'

describe('terminalOutputBuffer', () => {
  test('replays and clears terminal output by session', () => {
    clearTerminalOutput('session-a')
    clearTerminalOutput('session-b')

    appendTerminalOutput('session-a', 'hello')
    appendTerminalOutput('session-a', ' world')
    appendTerminalOutput('session-b', 'other')

    expect(readTerminalOutput('session-a')).toBe('hello world')
    expect(readTerminalOutput('session-b')).toBe('other')

    clearTerminalOutput('session-a')

    expect(readTerminalOutput('session-a')).toBe('')
    expect(readTerminalOutput('session-b')).toBe('other')
  })
})
