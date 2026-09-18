import type { LocalDeviceApp, LocalDeviceSkill } from '@/types/api'
import {
  filterSlashCommands as filterSharedSlashCommands,
  type SlashCommand as SharedSlashCommand,
} from '@wegent/collaboration/composer/composerAutocomplete'
import { compareComposerPluginsByUsage, readRecentPluginAppIds } from './composerPluginSort'
export * from '@wegent/collaboration/composer/composerAutocomplete'
export type SlashCommand = SharedSlashCommand<LocalDeviceApp, LocalDeviceSkill>
export function filterSlashCommands(
  commands: SlashCommand[],
  query: string,
  hasDraftText: boolean
): SlashCommand[] {
  const recent = readRecentPluginAppIds()
  return filterSharedSlashCommands(commands, query, hasDraftText, (left, right) =>
    compareComposerPluginsByUsage(left.app!, right.app!, recent)
  )
}
