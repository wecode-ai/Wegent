import { DeleteIconButton } from '@wegent/collaboration/controls/DeleteIconButton'
import { IconButton } from '@wegent/collaboration/controls/IconButton'
import type {
  PersonalStandInSettings,
  StandInHandlingPolicy,
  StandInProjectRef,
  StandInRole,
} from '@/api/personalStandIn'
import { roleIncludesProject, standInPolicy } from '@/api/personalStandIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Settings, UserRound } from 'lucide-react'
import { useState } from 'react'
import { projectScopeOf, type ExperienceProjectData } from '../model'

export interface AssistantTeamProps {
  settings: PersonalStandInSettings
  projects: readonly ExperienceProjectData[]
  onConfigure(roleId?: string): void
  onDelete(role: StandInRole): Promise<boolean>
  onRegister?(
    roleId: string | undefined,
    roleName: string,
    project: StandInProjectRef,
    policy: StandInHandlingPolicy
  ): Promise<boolean>
}

export function AssistantTeam({
  settings,
  projects,
  onConfigure,
  onDelete,
  onRegister,
}: AssistantTeamProps) {
  const { t } = useTranslation('collaborationExp')
  const [deleting, setDeleting] = useState<StandInRole | null>(null)
  const [pending, setPending] = useState(false)
  const [registering, setRegistering] = useState<string | null>(null)
  const scopedProjects = [
    ...new Map(projects.map(row => [projectScopeOf(row.project).key, row])).values(),
  ]
  const rows = [
    {
      id: '@primary',
      name: t('assistant.defaultAssistant'),
      role: null,
      collaboration: settings.primary?.collaboration,
    },
    ...settings.roles.map(role => ({
      id: role.id,
      name: role.name || t('assistant.specialist'),
      role,
      collaboration: role.collaboration,
    })),
  ]
  return (
    <section data-testid="collaboration-exp-assistant-team">
      <div className="flex items-center justify-between px-4 py-2">
        <h2 className="text-sm font-medium text-text-secondary">{t('assistant.team')}</h2>
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="collaboration-exp-assistant-team-manage"
          onClick={() => onConfigure()}
          className="min-h-11 px-2 text-xs text-text-muted hover:bg-muted md:min-h-8"
        >
          {t('assistant.manage')}
        </ControlButton>
      </div>
      {rows.map(({ id, name, role, collaboration }) => (
        <div
          key={id}
          className="flex min-h-11 flex-wrap items-center gap-3 border-b border-border/50 px-4 py-3"
          data-testid={`collaboration-exp-assistant-role-${id}`}
        >
          <UserRound aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
          <div className="min-w-0 flex-1">
            <span className="block truncate font-medium">{name}</span>
            <p className="mt-1 text-xs text-text-muted">
              {role
                ? scopedProjects
                    .filter(({ project }) =>
                      roleIncludesProject(role, {
                        id: project.id,
                        store: project.project_store === 'local' ? 'local' : 'cloud',
                      })
                    )
                    .map(({ project }) => project.name)
                    .join(' · ') || t('assistant.noProjectScope')
                : t('assistant.defaultProtected')}
            </p>
          </div>
          <IconButton
            type="button"
            data-testid={`collaboration-exp-assistant-configure-${id}`}
            aria-label={t('assistant.configureRole', { name })}
            onClick={() => onConfigure(role?.id)}
          >
            <Settings aria-hidden="true" className="size-4" />
          </IconButton>
          {role && (
            <DeleteIconButton
              type="button"
              data-testid={`collaboration-exp-assistant-delete-${id}`}
              aria-label={t('assistant.deleteRole', { name })}
              onClick={() => setDeleting(role)}
            />
          )}
          {onRegister && collaboration ? (
            <div className="col-span-full flex flex-wrap gap-2 pl-7">
              {scopedProjects
                .filter(
                  ({ project }) =>
                    collaboration &&
                    roleIncludesProject(
                      { collaboration },
                      {
                        id: project.id,
                        store: project.project_store === 'local' ? 'local' : 'cloud',
                      }
                    )
                )
                .filter(({ project }) => project.project_store !== 'local')
                .map(({ project }) => (
                  <ControlButton
                    variant="ghost"
                    size="sm"
                    key={project.id}
                    type="button"
                    data-testid={`collaboration-exp-assistant-register-${id}-${project.id}`}
                    disabled={registering !== null}
                    onClick={() => {
                      const projectRef = { id: project.id, store: 'cloud' as const }
                      const key = `${id}:${project.id}`
                      setRegistering(key)
                      void onRegister(
                        role?.id,
                        name,
                        projectRef,
                        standInPolicy(
                          role ?? {
                            collaboration,
                            enabled: settings.primary?.enabled ?? false,
                          },
                          projectRef
                        )
                      ).finally(() => setRegistering(current => (current === key ? null : current)))
                    }}
                    className="underline"
                  >
                    {t('create.registerInProject', { project: project.name })}
                  </ControlButton>
                ))}
            </div>
          ) : null}
        </div>
      ))}
      <ConfirmDialog
        open={deleting !== null}
        title={t('assistant.deleteRoleTitle')}
        description={t('assistant.deleteRoleDescription', {
          name: deleting?.name || t('assistant.specialist'),
        })}
        cancelLabel={t('assistant.cancel')}
        confirmLabel={t('assistant.delete')}
        confirmTestId="collaboration-exp-assistant-delete-confirm"
        dialogTestId="collaboration-exp-assistant-delete-dialog"
        pending={pending}
        destructive
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting || pending) return
          setPending(true)
          void onDelete(deleting)
            .then(success => {
              if (success) setDeleting(null)
            })
            .finally(() => setPending(false))
        }}
      />
    </section>
  )
}
