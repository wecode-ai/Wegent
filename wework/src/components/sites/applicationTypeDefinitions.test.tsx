import { describe, expect, test } from 'vitest'
import {
  WEGENT_MINI_PROGRAM_PLUGIN_NAME,
  WEGENT_SITES_PLUGIN_NAME,
} from '@/features/plugins/builtinPlugins'
import { getApplicationTypeDefinition } from './applicationTypeDefinitions'

describe('application type definitions', () => {
  test.each([
    ['site', WEGENT_SITES_PLUGIN_NAME],
    ['mini_program', WEGENT_MINI_PROGRAM_PLUGIN_NAME],
  ] as const)('maps %s creation to %s', (appType, pluginName) => {
    expect(getApplicationTypeDefinition(appType)?.create.pluginName).toBe(pluginName)
  })
})
