import { Folder, Plus } from 'lucide-react'
import type { CollaborationProject } from '@wegent/collaboration'
import type { StandInProjectRef, StandInRole } from '@/api/personalStandIn'
import { roleIncludesProject, standInPolicy } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'
import { TagEditor } from '@wegent/collaboration'
import { StandInHandlingSelect } from './StandInHandlingSelect'

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
      <div className="flex items-center gap-2">
        <Folder className="h-4 w-4" />
        <h3 className="flex-1 font-medium">{t('standIn.personal.collaboration')}</h3>
        <button
          type="button"
          role="switch"
          aria-checked={source.enabled}
          aria-label={t('standIn.personal.collaboration')}
          data-testid="stand-in-source-collaboration"
          disabled={disabled}
          onClick={() => setSource({ enabled: !source.enabled })}
          className={`inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 disabled:opacity-40 ${source.enabled ? 'bg-text-primary' : 'bg-border'}`}
        >
          <span
            className={`h-5 w-5 rounded-full bg-background transition-transform ${source.enabled ? 'translate-x-4' : ''}`}
          />
        </button>
      </div>
      {source.enabled && (
        <>
          {!role.agentProject && (
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 accent-text-primary"
                data-testid="stand-in-all-projects"
                checked={source.allProjects}
                disabled={disabled || Boolean(role.agentProject)}
                onChange={event => setSource({ allProjects: event.target.checked })}
              />
              <span>
                {t('standIn.personal.all_projects')}
                <span className="mt-1 block text-xs text-text-muted">
                  {t('standIn.personal.all_projects_help')}
                </span>
              </span>
            </label>
          )}
          {role.agentProject && (
            <p className="text-xs text-text-muted">
              {t('standIn.personal.project_agent_scope', {
                project:
                  projects.find(project => project.id === role.agentProject?.id)?.name ??
                  role.agentProject.id,
              })}
            </p>
          )}
          <div
            className="max-h-64 overflow-y-auto divide-y divide-border/50"
            data-testid="stand-in-source-projects"
          >
            {projects
              .filter(
                project =>
                  !role.agentProject ||
                  (project.id === role.agentProject.id &&
                    (project.project_store === 'local' ? 'local' : 'cloud') ===
                      role.agentProject.store)
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
                      checked={roleIncludesProject(role, ref(project))}
                      disabled={
                        disabled ||
                        (!allowLocalProjects &&
                          project.project_store === 'local' &&
                          !roleIncludesProject(role, ref(project)))
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
                  {roleIncludesProject(role, ref(project)) && (
                    <StandInHandlingSelect
                      policy={standInPolicy(role, ref(project))}
                      disabled={disabled}
                      label={t('standIn.workspace.handling_for', { name: project.name })}
                      testId={`stand-in-project-policy-${project.id}`}
                      onChange={policy =>
                        setSource({
                          projectPolicies: [
                            ...(source.projectPolicies ?? []).filter(
                              row => row.id !== project.id || row.store !== ref(project).store
                            ),
                            { ...ref(project), policy },
                          ],
                        })
                      }
                    />
                  )}
                </div>
              ))}
            {!projects.length && <p className="py-3 text-text-muted">{t('standIn.no_projects')}</p>}
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
                removeLabel={tag => t('standIn.personal.remove_tag', { tag })}
                testIdPrefix="stand-in-connection-tags"
              />
            </div>
            <p className="mt-2 text-xs text-text-muted">{t('standIn.personal.limit_tags_help')}</p>
          </details>
        </>
      )}
    </div>
  )
}
