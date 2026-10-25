import type { CollaborationProject } from '@wegent/collaboration'
import { ArrowUpRight, Bot, ChevronDown } from 'lucide-react'
import {
  roleIncludesProject,
  standInRoleName,
  type StandInRole,
  type PersonalStandInAgent,
} from '@/api/personalStandIn'
import type { StandInProjectAgentChoice } from './useStandInProjectAgents'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInProjectSetup({
  project,
  roles,
  projectRoleId,
  saving,
  creating,
  onChoose,
  role,
  agents,
  projectAgents,
  onOpenSettings,
}: {
  project: CollaborationProject
  roles: StandInRole[]
  projectRoleId: string
  saving: boolean
  creating: boolean
  onChoose(value: string): void
  role: StandInRole
  agents: PersonalStandInAgent[]
  projectAgents: StandInProjectAgentChoice[]
  onOpenSettings?(): void
}) {
  const { t } = useTranslation('common')
  const enabled =
    role.enabled &&
    roleIncludesProject(role, {
      id: project.id,
      store: project.project_store === 'local' ? 'local' : 'cloud',
    })
  return (
    <div className="space-y-4" data-testid="stand-in-project-setup">
      <label className="block space-y-2">
        <span className="font-medium">{t('standIn.personal.use_stand_in')}</span>
        <div className="relative rounded-lg border border-border bg-muted/40 hover:bg-muted/60 focus-within:ring-2 focus-within:ring-focus">
          <select
            data-testid="stand-in-project-select"
            value={creating ? '__new' : projectRoleId}
            disabled={saving}
            onChange={event => {
              onChoose(event.target.value)
            }}
            className="min-h-9 w-full cursor-pointer appearance-none rounded-lg bg-transparent pl-3 pr-10 text-base outline-none disabled:cursor-default"
          >
            <option value="" disabled>
              {t('standIn.personal.choose_stand_in')}
            </option>
            {roles
              .filter(
                row =>
                  !row.agentProject ||
                  (row.agentProject.id === project.id &&
                    row.agentProject.store ===
                      (project.project_store === 'local' ? 'local' : 'cloud'))
              )
              .map(row => (
                <option key={row.id} value={row.id}>
                  {standInRoleName(row, roles.indexOf(row), t('standIn.personal.default_role'))}
                </option>
              ))}
            <option value="__new">{t('standIn.personal.new_project_stand_in')}</option>
          </select>
          <ChevronDown
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary"
          />
        </div>
      </label>
      {!creating && projectRoleId && (
        <>
          <div className="py-1" data-testid="stand-in-project-summary">
            <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              <dt className="text-text-muted">{t('standIn.agent_label')}</dt>
              <dd className="flex items-center gap-2">
                <Bot className="h-4 w-4 shrink-0" />
                {role.agentResourceId
                  ? (agents.find(agent => agent.id === role.agentResourceId)?.name ??
                    t('standIn.agent_unavailable'))
                  : role.agentId
                    ? (projectAgents.find(
                        choice =>
                          choice.id === role.agentId && choice.project.id === role.agentProject?.id
                      )?.name ?? t('standIn.personal.project_agent'))
                    : t('standIn.default_agent')}
              </dd>
              {role.prompt && (
                <>
                  <dt className="text-text-muted">{t('standIn.personal.requirements_summary')}</dt>
                  <dd className="whitespace-pre-wrap break-words">
                    {role.prompt || t('standIn.personal.no_requirements')}
                  </dd>
                </>
              )}
              <dt className="text-text-muted">{t('standIn.personal.automatic_summary')}</dt>
              <dd>{t(enabled ? 'standIn.auto_on' : 'standIn.auto_off')}</dd>
            </dl>
            {!enabled && (
              <p
                data-testid="stand-in-project-enable-help"
                className="mt-3 text-xs text-text-muted"
              >
                {t('standIn.personal.enable_and_use_help')}
              </p>
            )}
            {enabled && (
              <p className="mt-3 text-xs text-text-muted">
                {t('standIn.personal.disable_project_help')}
              </p>
            )}
          </div>
          {onOpenSettings && (
            <div className="text-xs text-text-muted">
              <button
                type="button"
                disabled={saving}
                data-testid="stand-in-personal-settings-link"
                onClick={onOpenSettings}
                className="inline-flex min-h-8 items-center gap-1 text-primary hover:underline"
              >
                {t('standIn.personal.open_personal_settings')}
                <ArrowUpRight className="h-3 w-3" />
              </button>
              <p>{t('standIn.personal.shared_settings_help')}</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
