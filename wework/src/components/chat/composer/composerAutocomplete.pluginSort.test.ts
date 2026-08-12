import { Boxes } from 'lucide-react'
import { beforeEach, describe, expect, test } from 'vitest'
import { recordPluginUsage } from '@/features/plugins/pluginTrial'
import type { LocalDeviceApp } from '@/types/api'
import { filterSlashCommands, type SlashCommand } from './composerAutocomplete'

function pluginCommand(app: LocalDeviceApp, aliases: string[]): SlashCommand {
  return {
    id: `app:${app.id}`,
    title: app.name,
    group: '插件',
    searchAliases: aliases,
    Icon: Boxes,
    testId: app.id,
    app,
  }
}

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

describe('filterSlashCommands plugin usage tie-break', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('uses usage comparator when match scores are equal', () => {
    recordPluginUsage('EchoID')
    recordPluginUsage('EchoID')
    recordPluginUsage('GitHub')

    const commands = [pluginCommand(githubApp, ['tool']), pluginCommand(echoIdApp, ['tool'])]

    const filtered = filterSlashCommands(commands, 'tool', false)
    expect(filtered.map(command => command.app?.id)).toEqual(['echoid', 'github'])
  })
})
