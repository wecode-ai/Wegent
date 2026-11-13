import { useState } from 'react'
import { Settings, Trash2, UserRound } from 'lucide-react'
import type { PersonalStandInSettings, StandInRole } from '@/api/personalStandIn'
import { roleIncludesProject } from '@/api/personalStandIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import type { ExperienceProjectData } from '../model'

export interface AssistantTeamProps {
  settings: PersonalStandInSettings
  projects: readonly ExperienceProjectData[]
  onConfigure(roleId?: string): void
  onDelete(role: StandInRole): Promise<boolean>
}

export function AssistantTeam({ settings, projects, onConfigure, onDelete }: AssistantTeamProps) {
  const { t } = useTranslation('collaborationExp')
  const [deleting, setDeleting] = useState<StandInRole | null>(null)
  const [pending, setPending] = useState(false)
  const rows = [
    { id: '@primary', name: t('assistant.defaultAssistant'), role: null },
    ...settings.roles.map(role => ({
      id: role.id,
      name: role.name || t('assistant.specialist'),
      role,
    })),
  ]
  return (
    <section data-testid="collaboration-exp-assistant-team">
      <div className="flex items-center justify-between px-4 py-2">
        <h2 className="text-sm font-medium text-text-secondary">{t('assistant.team')}</h2>
        <button
          type="button"
          data-testid="collaboration-exp-assistant-team-manage"
          onClick={() => onConfigure()}
          className="min-h-11 px-2 text-xs text-text-muted hover:bg-muted md:min-h-8"
        >
          {t('assistant.manage')}
        </button>
      </div>
      {rows.map(({ id, name, role }) => (
        <div
          key={id}
          className="flex min-h-11 items-center gap-3 border-b border-border/50 px-4 py-3"
          data-testid={`collaboration-exp-assistant-role-${id}`}
        >
          <UserRound aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
          <div className="min-w-0 flex-1">
            <span className="block truncate font-medium">{name}</span>
            <p className="mt-1 text-xs text-text-muted">
              {role
                ? projects
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
          <button
            type="button"
            data-testid={`collaboration-exp-assistant-configure-${id}`}
            aria-label={t('assistant.configureRole', { name })}
            onClick={() => onConfigure(role?.id)}
            className="inline-flex size-11 shrink-0 items-center justify-center text-text-muted hover:bg-muted md:size-8"
          >
            <Settings aria-hidden="true" className="size-4" />
          </button>
          {role && (
            <button
              type="button"
              data-testid={`collaboration-exp-assistant-delete-${id}`}
              aria-label={t('assistant.deleteRole', { name })}
              onClick={() => setDeleting(role)}
              className="inline-flex size-11 shrink-0 items-center justify-center text-text-muted hover:bg-muted md:size-8"
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </button>
          )}
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
