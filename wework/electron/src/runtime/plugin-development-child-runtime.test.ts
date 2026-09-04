import { describe, expect, test } from 'vitest'
import { isPluginDevelopmentSourceChange } from './plugin-development-child-runtime.js'

describe('PluginDevelopmentChildRuntime', () => {
  test('ignores generated dependency and git changes', () => {
    expect(isPluginDevelopmentSourceChange('client.js')).toBe(true)
    expect(isPluginDevelopmentSourceChange(null)).toBe(true)
    expect(isPluginDevelopmentSourceChange('node_modules/dependency/index.js')).toBe(false)
    expect(isPluginDevelopmentSourceChange('.git/index')).toBe(false)
  })
})
