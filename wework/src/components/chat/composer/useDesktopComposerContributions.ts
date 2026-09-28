import { useMemo } from 'react'
import { Blocks } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useDshComposerReferences } from '@/features/dsh-runtime/useDshComposerReferences'
import { useDshMenuCommands } from '@/features/dsh-runtime/useDshMenuCommands'
import type { ComposerMentionCandidate } from './composerMentionCandidates'
import type { SlashCommand } from './composerAutocomplete'
export function useDesktopComposerContributions(query: string) {
  const { t } = useTranslation('common')
  const contributedReferenceEntries = useDshComposerReferences(query)
  const contributedMentionCandidates = useMemo<ComposerMentionCandidate[]>(
    () =>
      contributedReferenceEntries.map(reference => ({
        kind: 'extension',
        key: `extension:${reference.id}`,
        title: reference.title,
        description: reference.description,
        metaLabel: reference.metaLabel ?? t('workbench.extensions', '扩展'),
        testId: reference.id,
        enabled: reference.enabled,
        reference: reference.reference,
        searchAliases: [...(reference.searchAliases ?? [])],
      })),
    [contributedReferenceEntries, t]
  )

  const contributedSlashMenuCommands = useDshMenuCommands('composer.slash')
  const contributedSlashCommands = useMemo<SlashCommand[]>(
    () =>
      contributedSlashMenuCommands.map(command => ({
        id: command.id,
        title: command.title,
        description: command.definition.description,
        group:
          command.group ??
          command.definition.category ??
          t('workbench.slash_command_group_extensions', '扩展'),
        searchAliases: [command.command, command.definition.category].filter(
          (value): value is string => Boolean(value)
        ),
        Icon: Blocks,
        enabled: command.enabled,
        testId: `dsh-command-${command.id}`,
        extensionCommand: {
          command: command.command,
          menuId: command.id,
        },
      })),
    [contributedSlashMenuCommands, t]
  )

  return { contributedMentionCandidates, contributedSlashCommands }
}
