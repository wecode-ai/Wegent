import { Bot, SquareTerminal, Users } from 'lucide-react'
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu'
import { ExperimentalBadge } from '@/features/experimental-features/ExperimentalBadge'
import { useTranslation } from '@/hooks/useTranslation'
import { localHarnessLabel, type LocalHarnessId } from '@/lib/local-harness'
import type { Team } from '@/types/api'
import type { LocalHarnessDescriptor } from '@/lib/local-terminal'

interface WorkbenchHarnessSelectorProps {
  runtime: 'codex' | LocalHarnessId
  harnesses: LocalHarnessDescriptor[]
  enabledHarnesses: LocalHarnessId[]
  loading: boolean
  detectionFailed: boolean
  onRuntimeChange: (runtime: 'codex' | LocalHarnessId) => void
  teams?: Team[]
  selectedTeamId?: number | null
  teamsLoading?: boolean
  onTeamChange?: (team: Team | null) => void
}

function teamLabel(team: Team): string {
  return team.displayName?.trim() || team.name
}

export function WorkbenchHarnessSelector({
  runtime,
  harnesses,
  enabledHarnesses,
  loading,
  detectionFailed,
  onRuntimeChange,
  teams = [],
  selectedTeamId = null,
  teamsLoading = false,
  onTeamChange,
}: WorkbenchHarnessSelectorProps) {
  const { t } = useTranslation('common')
  const selectedTeam =
    runtime === 'codex' ? (teams.find(team => team.id === selectedTeamId) ?? null) : null
  const selectedLabel = selectedTeam
    ? teamLabel(selectedTeam)
    : runtime === 'codex'
      ? 'Codex'
      : localHarnessLabel(runtime)
  const SelectedIcon = selectedTeam
    ? Users
    : runtime === 'codex' || runtime === 'claude_code'
      ? Bot
      : SquareTerminal
  const selectCodex = () => {
    onTeamChange?.(null)
    onRuntimeChange('codex')
  }
  const selectTeam = (team: Team) => {
    onRuntimeChange('codex')
    onTeamChange?.(team)
  }
  const selectHarness = (harnessId: LocalHarnessId) => {
    onTeamChange?.(null)
    onRuntimeChange(harnessId)
  }
  const items: ActionMenuItem[] = [
    {
      label: 'Codex',
      icon: Bot,
      testId: 'workbench-harness-option-codex',
      checked: runtime === 'codex' && !selectedTeam,
      onSelect: selectCodex,
    },
    ...teams.map(team => ({
      label: teamLabel(team),
      icon: Users,
      testId: `workbench-team-option-${team.id}`,
      checked: selectedTeam?.id === team.id,
      disabled: teamsLoading,
      onSelect: () => selectTeam(team),
    })),
    ...enabledHarnesses.map(harnessId => {
      const label = localHarnessLabel(harnessId)
      const installed = harnesses.some(harness => harness.id === harnessId && harness.installed)
      return {
        label: (
          <>
            <span className="min-w-0 flex-1 truncate">
              {loading
                ? t('workbench.harness_detecting', {
                    name: label,
                    defaultValue: `正在检测 ${label}`,
                  })
                : detectionFailed
                  ? t('workbench.harness_detection_failed', {
                      name: label,
                      defaultValue: `${label}（检测失败）`,
                    })
                  : installed
                    ? label
                    : t('workbench.harness_unavailable', {
                        name: label,
                        defaultValue: `${label}（未安装）`,
                      })}
            </span>
            <ExperimentalBadge testId={`workbench-harness-option-${harnessId}-badge`} />
          </>
        ),
        icon: harnessId === 'claude_code' ? Bot : SquareTerminal,
        testId: `workbench-harness-option-${harnessId}`,
        checked: runtime === harnessId,
        disabled: loading || detectionFailed || !installed,
        onSelect: () => selectHarness(harnessId),
      }
    }),
  ]

  return (
    <ActionMenu
      ariaLabel={t('workbench.execution_selector', '选择执行方式')}
      testId="workbench-harness-selector"
      icon={SelectedIcon}
      triggerLabel={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="max-w-40 truncate">{selectedLabel}</span>
          {(selectedTeam || runtime !== 'codex') && (
            <ExperimentalBadge testId="workbench-harness-experimental-badge" />
          )}
        </span>
      }
      placement="bottom-end"
      triggerClassName="flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-text-secondary hover:bg-background/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      items={items}
    />
  )
}
