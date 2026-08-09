import { describe, expect, test } from 'vitest'
import {
  WEGENT_MINI_PROGRAM_PLUGIN_NAME,
  WEGENT_SITES_PLUGIN_NAME,
  isSystemApplicationConnectorSlug,
} from './builtinPlugins'

describe('isSystemApplicationConnectorSlug', () => {
  test('hides Sites and Mini Program connectors from the composer picker', () => {
    expect(isSystemApplicationConnectorSlug(WEGENT_SITES_PLUGIN_NAME)).toBe(true)
    expect(isSystemApplicationConnectorSlug(WEGENT_MINI_PROGRAM_PLUGIN_NAME)).toBe(true)
  })

  test('keeps ordinary connectors visible', () => {
    expect(isSystemApplicationConnectorSlug('dingtalk')).toBe(false)
    expect(isSystemApplicationConnectorSlug('github')).toBe(false)
  })
})
