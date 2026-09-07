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
  const cloudTeamItems: ActionMenuItem[] = teams.map(team => ({
    label: teamLabel(team),
    icon: Users,
    testId: `workbench-team-option-${team.id}`,
    checked: selectedTeam?.id === team.id,
    disabled: teamsLoading,
    onSelect: () => {
      onRuntimeChange('codex')
      onTeamChange?.(team)
    },
  }))
  const localHarnessItems: ActionMenuItem[] = enabledHarnesses.map(harnessId => {
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
      onSelect: () => {
        onTeamChange?.(null)
        onRuntimeChange(harnessId)
      },
    }
  })
  const items: ActionMenuItem[] = [
    {
      label: 'Codex',
      icon: Bot,
      testId: 'workbench-harness-option-codex',
      checked: runtime === 'codex' && !selectedTeam,
      onSelect: () => {
        onTeamChange?.(null)
        onRuntimeChange('codex')
      },
    },
    {
      label: '',
      testId: 'workbench-cloud-agent-separator',
      separator: true,
    },
    {
      label: '',
      testId: 'workbench-cloud-agent-heading',
      custom: (
        <div className="px-2 py-1 text-xs font-medium text-text-tertiary">
          {t('workbench.cloud_agents_group', '云端智能体')}
        </div>
      ),
    },
    ...(teamsLoading
      ? [
          {
            label: '',
            testId: 'workbench-cloud-agent-loading',
            custom: (
              <div className="px-2 py-1.5 text-sm text-text-tertiary">
                {t('workbench.cloud_agents_loading', '正在加载云端智能体…')}
              </div>
            ),
          },
        ]
      : cloudTeamItems.length > 0
        ? cloudTeamItems
        : [
            {
              label: '',
              testId: 'workbench-cloud-agent-empty',
              custom: (
                <div className="px-2 py-1.5 text-sm text-text-tertiary">
                  {t('workbench.cloud_agents_empty', '连接云端后显示可用智能体')}
                </div>
              ),
            },
          ]),
    ...(localHarnessItems.length > 0
      ? [
          {
            label: '',
            testId: 'workbench-local-harness-separator',
            separator: true,
          },
          {
            label: '',
            testId: 'workbench-local-harness-heading',
            custom: (
              <div className="px-2 py-1 text-xs font-medium text-text-tertiary">
                {t('workbench.local_harnesses_group', '本地编码工具')}
              </div>
            ),
          },
          ...localHarnessItems,
        ]
      : []),
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
