import { describe, expect, test } from 'vitest'
import {
  buildPluginDetailRoute,
  isWegentCloudMarketplace,
  parsePluginDetailRoute,
  parsePluginMentionReference,
  parsePluginUri,
} from './pluginNavigation'

describe('pluginNavigation', () => {
  test('builds and parses a plugin detail route', () => {
    const reference = {
      pluginName: 'wegent-sites',
      marketplaceName: 'wegent-bundled',
    }

    expect(buildPluginDetailRoute(reference)).toBe(
      '/plugins?plugin=wegent-sites&marketplace=wegent-bundled'
    )
    expect(parsePluginDetailRoute('?plugin=wegent-sites&marketplace=wegent-bundled')).toEqual(
      reference
    )
  })

  test('parses plugin URIs and composer references with scoped names', () => {
    const reference = {
      pluginName: '@wegent/sites',
      marketplaceName: 'Wegent Bundled',
    }

    expect(parsePluginUri('plugin://@wegent/sites@Wegent Bundled')).toEqual(reference)
    expect(parsePluginMentionReference('[$站点](plugin://@wegent/sites@Wegent Bundled)')).toEqual(
      reference
    )
  })

  test('rejects incomplete plugin references', () => {
    expect(parsePluginUri('plugin://wegent-sites')).toBeNull()
    expect(parsePluginMentionReference('[$站点](/tmp/sites/SKILL.md)')).toBeNull()
    expect(parsePluginDetailRoute('?plugin=wegent-sites')).toBeNull()
  })

  test('recognizes stable Wegent cloud marketplace aliases', () => {
    expect(isWegentCloudMarketplace('wegent')).toBe(true)
    expect(isWegentCloudMarketplace('wework')).toBe(true)
    expect(isWegentCloudMarketplace('wegent-marketplace')).toBe(true)
    expect(isWegentCloudMarketplace('default')).toBe(true)
    expect(isWegentCloudMarketplace('wegent-bundled')).toBe(false)
  })
})
