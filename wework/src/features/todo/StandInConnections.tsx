import { StandInConnectionHeader } from './StandInConnectionHeader'
import { SettingsSwitch } from '@/components/settings/settings-ui'
import { Folder, Plus } from 'lucide-react'
import type { CollaborationProject } from '@wegent/collaboration'
import type { StandInHandlingPolicy, StandInProjectRef, StandInRole } from '@/api/personalStandIn'
import { roleSelectsProject, standInPolicy } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'
import { TagEditor } from '@wegent/collaboration'
import { StandInProcessingSettings } from './StandInProcessingSettings'

/** Edit project intake scope, exclusions and handling policies for an independent stand-in. */
export function StandInConnections({
  role,
  projects,
  allowLocalProjects,
  onChange,
  disabled,
  focusedProjectId,
}: {
  role: StandInRole
  projects: CollaborationProject[]
  allowLocalProjects: boolean
  onChange(role: StandInRole): void
  disabled: boolean
  focusedProjectId?: string
}) {
  const { t } = useTranslation('common')
  const source = role.collaboration
  const setSource = (patch: Partial<typeof source>) =>
    onChange({ ...role, collaboration: { ...source, ...patch } })
  const ref = (project: CollaborationProject): StandInProjectRef => ({
    id: project.id,
    store: project.project_store === 'local' ? 'local' : 'cloud',
  })
  const toggleProject = (project: CollaborationProject, checked: boolean) => {
    const value = ref(project)
    const without = (rows: StandInProjectRef[]) =>
      rows.filter(row => row.id !== value.id || row.store !== value.store)
    setSource(
      source.allProjects
        ? {
            excludedProjects: checked
              ? without(source.excludedProjects)
              : [...without(source.excludedProjects), value],
          }
        : { projects: checked ? [...without(source.projects), value] : without(source.projects) }
    )
  }
  return (
    <div className="space-y-4" data-testid="stand-in-connections">
      <StandInConnectionHeader
        icon={Folder}
        title={t('standIn.personal.collaboration')}
        description={t('standIn.workspace.project_connection_help')}
      />
      <label className="flex min-h-9 items-center justify-between gap-3 text-sm">
        <span>{t('standIn.workspace.receive_project_items')}</span>
        <SettingsSwitch
          data-testid="stand-in-source-collaboration"
          checked={source.enabled}
          disabled={disabled}
          onCheckedChange={enabled => setSource({ enabled })}
          aria-label={t('standIn.personal.collaboration')}
        />
      </label>
      <fieldset disabled={disabled || !source.enabled} className="space-y-4">
        <legend className="mb-2 text-sm font-medium">
          {t('standIn.workspace.connection_scope')}
        </legend>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 accent-text-primary"
            data-testid="stand-in-all-projects"
            checked={source.allProjects}
            disabled={disabled}
            onChange={event => setSource({ allProjects: event.target.checked })}
          />
          <span>
            {t('standIn.personal.all_projects')}
            <span className="mt-1 block text-xs text-text-muted">
              {t('standIn.personal.all_projects_help')}
            </span>
          </span>
        </label>
        <div
          className="max-h-64 overflow-y-auto divide-y divide-border/50"
          data-testid="stand-in-source-projects"
        >
          {/* Remote all-project scope uses that Executor's catalog, not this computer's. */}
          {projects
            .filter(
              project =>
                allowLocalProjects ||
                project.project_store !== 'local' ||
                source.projects.some(row => row.store === 'local' && row.id === project.id)
            )
            .map(project => (
              <div
                key={`${project.project_store}:${project.id}`}
                className={`flex min-h-11 items-center gap-3 rounded-md px-2 md:min-h-9 ${project.id === focusedProjectId ? 'bg-muted' : ''}`}
              >
                <label className="flex min-w-0 flex-1 items-center gap-3">
                  <input
                    type="checkbox"
                    className="accent-text-primary"
                    data-testid={`stand-in-connect-project-${project.id}`}
                    aria-label={project.name}
                    checked={roleSelectsProject(role, ref(project))}
                    disabled={
                      disabled ||
                      (!allowLocalProjects &&
                        project.project_store === 'local' &&
                        !roleSelectsProject(role, ref(project)))
                    }
                    onChange={event => toggleProject(project, event.target.checked)}
                  />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  <span className="text-xs text-text-muted">
                    {t(
                      project.project_store === 'local'
                        ? 'standIn.personal.local'
                        : 'standIn.personal.cloud'
                    )}
                  </span>
                </label>
              </div>
            ))}
          {!projects.length && (
            <p className="py-3 text-text-muted">
              {t(
                source.allProjects
                  ? 'standIn.workspace.connection_projects_empty_all'
                  : 'standIn.workspace.connection_projects_empty_selected'
              )}
            </p>
          )}
        </div>
        <details
          className="border-t border-border pt-3"
          open={source.tags.length ? true : undefined}
        >
          <summary
            className="flex min-h-9 cursor-pointer items-center gap-2 text-text-secondary"
            data-testid="stand-in-source-tags-toggle"
          >
            <Plus className="h-4 w-4" />
            {t('standIn.personal.limit_tags')}
          </summary>
          <div className="mt-2 rounded-md border border-border p-2">
            <TagEditor
              tags={source.tags}
              onChange={tags => setSource({ tags })}
              disabled={disabled}
              suggestions={[...new Set(projects.flatMap(project => project.tags ?? []))]}
              placeholder={t('standIn.personal.add_tag')}
              lengthErrorLabel={t('standIn.personal.tag_too_long')}
              removeLabel={tag => t('standIn.personal.remove_tag', { tag })}
              testIdPrefix="stand-in-connection-tags"
            />
          </div>
          <p className="mt-2 text-xs text-text-muted">{t('standIn.personal.limit_tags_help')}</p>
        </details>
      </fieldset>
      <StandInProcessingSettings
        disabled={disabled}
        rows={[
          {
            key: 'default',
            name: t('standIn.workspace.default_processing'),
            testId: 'stand-in-project-default-policy',
            policy: standInPolicy(role),
            onChange: (policy: StandInHandlingPolicy) => setSource({ policy }),
          },
          ...projects
            .filter(project => roleSelectsProject(role, ref(project)))
            .map(project => ({
              key: `${project.project_store}:${project.id}`,
              name: project.name,
              policy: standInPolicy(role, ref(project)),
              testId: `stand-in-project-policy-${project.id}`,
              onChange: (policy: StandInHandlingPolicy) =>
                setSource({
                  projectPolicies: [
                    ...(source.projectPolicies ?? []).filter(
                      row => row.id !== project.id || row.store !== ref(project).store
                    ),
                    { ...ref(project), policy },
                  ],
                }),
            })),
        ]}
      />
    </div>
  )
}
