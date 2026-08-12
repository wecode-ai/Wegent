import { describe, expect, test } from 'vitest'
import { connectorDisplayName, isOpaqueConnectorId } from './connectorDisplayName'

describe('connectorDisplayName', () => {
  test('keeps known marketplace slugs readable', () => {
    expect(connectorDisplayName('github')).toBe('GitHub')
    expect(connectorDisplayName('gmail')).toBe('Gmail')
  })

  test('prefers connector-app display names', () => {
    expect(
      connectorDisplayName('2128aebfecb84f64a069897515042a44', {
        appName: 'Gmail',
        pluginName: 'Gmail',
      })
    ).toBe('Gmail')
  })

  test('falls back to plugin name for opaque OpenAI connector ids', () => {
    expect(isOpaqueConnectorId('2128aebfecb84f64a069897515042a44')).toBe(true)
    expect(
      connectorDisplayName('2128aebfecb84f64a069897515042a44', {
        pluginName: 'Gmail',
      })
    ).toBe('Gmail')
    expect(connectorDisplayName('2128aebfecb84f64a069897515042a44')).toBe('')
  })

  test('title-cases ordinary unknown slugs', () => {
    expect(connectorDisplayName('google-calendar')).toBe('Google Calendar')
  })
})
