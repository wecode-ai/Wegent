import { describe, expect, test } from 'vitest'
import { getApplicationTypeDefinition } from './applicationTypeDefinitions'

describe('application type definitions', () => {
  test.each(['web', 'miniapp'] as const)(
    'keeps %s creation identity out of static UI metadata',
    appType => {
      const create = getApplicationTypeDefinition(appType)?.create
      expect(create?.pluginName).toBeUndefined()
      expect(create?.marketplaceName).toBeUndefined()
    }
  )
})
