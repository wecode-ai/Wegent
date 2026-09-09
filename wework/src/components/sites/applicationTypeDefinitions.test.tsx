import { describe, expect, test } from 'vitest'
import {
  defaultResolvedApplicationTypes,
  getApplicationTypeDefinition,
} from './applicationTypeDefinitions'

describe('application type definitions', () => {
  test.each(['web', 'miniapp'] as const)(
    'keeps %s creation identity out of static UI metadata',
    appType => {
      const create = getApplicationTypeDefinition(appType)?.create
      expect(create?.pluginName).toBeUndefined()
      expect(create?.marketplaceName).toBeUndefined()
    }
  )

  test('does not expose create capability before cloud descriptors or cached descriptors load', () => {
    expect(defaultResolvedApplicationTypes().map(item => [...item.capabilities])).toEqual([
      ['publish', 'edit', 'delete', 'configure_environment', 'manage_access'],
      ['open_experience'],
    ])
  })
})
