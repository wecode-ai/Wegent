import { describe, expect, test } from 'vitest'
import { getErrorMessage } from './error-message'

describe('getErrorMessage', () => {
  test('prefers Error.message', () => {
    expect(getErrorMessage(new Error('boom'), 'fallback')).toBe('boom')
  })

  test('accepts Tauri string rejections', () => {
    expect(getErrorMessage('Local plugin is missing .codex-plugin/plugin.json', 'fallback')).toBe(
      'Local plugin is missing .codex-plugin/plugin.json'
    )
  })

  test('reads message from plain objects', () => {
    expect(getErrorMessage({ message: 'network down' }, 'fallback')).toBe('network down')
  })

  test('falls back when empty', () => {
    expect(getErrorMessage({}, 'fallback')).toBe('fallback')
    expect(getErrorMessage('', 'fallback')).toBe('fallback')
  })
})
