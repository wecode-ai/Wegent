import { beforeEach, describe, expect, test } from 'vitest'
import { recordPluginUsage } from '@/features/plugins/pluginTrial'
import type { LocalDeviceApp } from '@/types/api'
import {
  RECENT_PLUGIN_APPS_KEY,
  compareComposerPluginsByUsage,
  sortComposerPluginsByUsage,
} from './composerPluginSort'

const githubApp: LocalDeviceApp = {
  id: 'github',
  name: 'GitHub',
  isAccessible: true,
  isEnabled: true,
}

const echoIdApp: LocalDeviceApp = {
  id: 'echoid',
  name: 'EchoID',
  isAccessible: true,
  isEnabled: true,
}

const superpowersApp: LocalDeviceApp = {
  id: 'plugin:superpowers',
  name: 'superpowers',
  isAccessible: true,
  isEnabled: true,
  source: 'installed-plugin',
}

describe('composerPluginSort', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('sorts by 30-day usage descending using display names as keys', () => {
    recordPluginUsage('EchoID')
    recordPluginUsage('EchoID')
    recordPluginUsage('GitHub')

    expect(
      sortComposerPluginsByUsage([githubApp, echoIdApp, superpowersApp]).map(app => app.id)
    ).toEqual(['echoid', 'github', 'plugin:superpowers'])
  })

  test('breaks usage ties with recent picker selection order', () => {
    recordPluginUsage('GitHub')
    recordPluginUsage('EchoID')
    window.localStorage.setItem(RECENT_PLUGIN_APPS_KEY, JSON.stringify(['echoid', 'github']))

    expect(sortComposerPluginsByUsage([githubApp, echoIdApp]).map(app => app.id)).toEqual([
      'echoid',
      'github',
    ])
  })

  test('breaks remaining ties with display name', () => {
    expect(compareComposerPluginsByUsage(echoIdApp, githubApp, new Map())).toBe(
      'EchoID'.localeCompare('GitHub')
    )
  })
})
