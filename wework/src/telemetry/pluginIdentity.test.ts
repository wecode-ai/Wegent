import { describe, expect, test } from 'vitest'
import { pluginTelemetryIdentityFromParts } from './pluginIdentity'

describe('plugin telemetry identity', () => {
  test('keeps safe marketplace identities distinct across personal plugins', () => {
    expect(
      pluginTelemetryIdentityFromParts({
        marketplace: 'personal',
        pluginKey: 'first-plugin',
        visibility: 'personal',
      })
    ).toEqual({
      plugin_distribution: 'personal',
      plugin_id: 'personal/first-plugin',
    })
    expect(
      pluginTelemetryIdentityFromParts({
        marketplace: 'personal',
        pluginKey: 'second-plugin',
        visibility: 'personal',
      }).plugin_id
    ).toBe('personal/second-plugin')
  })

  test('replaces unsafe user-controlled segments with stable opaque identifiers', () => {
    const identity = pluginTelemetryIdentityFromParts({
      marketplace: 'https://github.com/private-org/private-marketplace',
      pluginKey: '/Users/example/private plugin',
      sourceProvider: 'user',
    })
    const repeated = pluginTelemetryIdentityFromParts({
      marketplace: 'https://github.com/private-org/private-marketplace',
      pluginKey: '/Users/example/private plugin',
      sourceProvider: 'user',
    })

    expect(identity).toEqual(repeated)
    expect(identity.plugin_distribution).toBe('personal')
    expect(identity.plugin_id).toMatch(/^personal\/opaque-[a-f0-9]{16}$/)
    expect(identity.plugin_id).not.toContain('private-org')
    expect(identity.plugin_id).not.toContain('/Users')
  })
})
