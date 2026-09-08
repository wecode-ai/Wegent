import { Bot, Users } from 'lucide-react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { ExperimentalBadge } from '@/features/experimental-features/ExperimentalBadge'
import { useTranslation } from '@/hooks/useTranslation'
import type { Team } from '@/types/api'

interface WorkbenchAgentSelectorProps {
  teams: Team[]
  selectedTeamId: number | null
  loading: boolean
  onTeamChange: (team: Team | null) => void
}

function teamLabel(team: Team): string {
  return team.displayName?.trim() || team.name
}

export function WorkbenchAgentSelector({
  teams,
  selectedTeamId,
  loading,
  onTeamChange,
}: WorkbenchAgentSelectorProps) {
  const { t } = useTranslation('common')
  const selectedTeam = teams.find(team => team.id === selectedTeamId) ?? null

  return (
    <ActionMenu
      ariaLabel={t('workbench.agent_selector', '选择智能体')}
      testId="workbench-agent-selector"
      icon={selectedTeam ? Users : Bot}
      triggerLabel={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="max-w-40 truncate">
            {selectedTeam ? teamLabel(selectedTeam) : t('workbench.no_agent', '智能体')}
          </span>
          {selectedTeam && <ExperimentalBadge testId="workbench-agent-experimental-badge" />}
        </span>
      }
      placement="bottom-end"
      triggerClassName="flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-text-secondary hover:bg-background/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      items={[
        {
          label: t('workbench.no_agent', '不使用云端智能体'),
          icon: Bot,
          testId: 'workbench-agent-option-none',
          checked: !selectedTeam,
          onSelect: () => onTeamChange(null),
        },
        ...teams.map(team => ({
          label: teamLabel(team),
          icon: Users,
          testId: `workbench-agent-option-${team.id}`,
          checked: selectedTeam?.id === team.id,
          disabled: loading,
          onSelect: () => onTeamChange(team),
        })),
      ]}
    />
  )
}
