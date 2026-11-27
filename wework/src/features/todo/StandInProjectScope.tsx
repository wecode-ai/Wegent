import type { StandInProjectRef, StandInProjectTrigger } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'
import type { CollaborationProject } from '@wegent/collaboration'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import { TextField } from '@wegent/collaboration/controls/TextField'
import { useState } from 'react'
import {
  ConnectionChoice,
  ConnectionFixedTrigger,
  type ConnectionScopeRule,
} from './ConnectionScopeFields'
import { ConnectionScopeList, ConnectionScopeRow } from './ConnectionScopeList'
import { useConnectionScopeBack, useConnectionScopeTitle } from './connectionScopeNavigation'
import { hasAllCollaborationSources, projectRefKey, type ProjectSource } from './standInProjects'
import { Button } from '@wegent/collaboration/markdown/Button'

const issueKeys = ['includeParticipatingIssues', 'includeIndependentIssues'] as const
const triggerModes = ['both', 'assignment', 'mention'] as const
const projectRules = ['include', 'all', 'exclude', 'off'] as const
export type ProjectScopeEditor = 'choose' | 'all' | 'projects' | (typeof issueKeys)[number] | null

export function StandInProjectScope({
  source,
  projects,
  allowLocalProjects,
  focusedProjectId,
  disabled,
  editor,
  setEditor: setScopeEditor,
  onBack,
  onChange,
}: {
  source: ProjectSource
  projects: CollaborationProject[]
  allowLocalProjects: boolean
  focusedProjectId?: string
  disabled: boolean
  editor: ProjectScopeEditor
  setEditor(editor: ProjectScopeEditor): void
  onBack(action: () => void): void
  onChange(patch: Partial<ProjectSource>): void
}) {
  const { t } = useTranslation('common')
  const setScopeTitle = useConnectionScopeTitle()
  const setEditor = (next: ProjectScopeEditor) => {
    setScopeEditor(next)
    setScopeTitle?.(
      next
        ? t(
            next === 'choose'
              ? 'standIn.workspace.connection_add_scope'
              : next === 'all'
                ? 'standIn.workspace.project_scope_all'
                : next === 'projects'
                  ? 'standIn.workspace.project_scope_projects_and_independent'
                  : next === 'includeIndependentIssues'
                    ? 'standIn.workspace.project_scope_independent'
                    : 'standIn.workspace.receive_participating_issues'
          )
        : null
    )
  }
  const [openedFromAdd, setOpenedFromAdd] = useState(false)
  const [ruleDraft, setRuleDraft] = useState<ConnectionScopeRule>()
  const [query, setQuery] = useState('')
  const rule =
    ruleDraft ??
    (source.allProjects ? (source.excludedProjects.length ? 'exclude' : 'all') : 'include')
  const isList = rule === 'include' || rule === 'exclude'
  const excludedKeys = new Set(source.excludedProjects.map(projectRefKey))
  const selected =
    rule === 'exclude'
      ? source.excludedProjects
      : source.projects.filter(ref => !excludedKeys.has(projectRefKey(ref)))
  const selectedKeys = new Set(selected.map(projectRefKey))
  const onlyLocalProjects =
    !source.allProjects && selected.length > 0 && selected.every(ref => ref.store === 'local')
  const catalog = new Map<string, { ref: StandInProjectRef; name: string }>()
  if (editor === 'projects' && isList) {
    for (const project of projects) {
      const ref: StandInProjectRef = {
        id: project.id,
        store: project.project_store === 'local' ? 'local' : 'cloud',
      }
      const key = projectRefKey(ref)
      if (allowLocalProjects || ref.store === 'cloud' || selectedKeys.has(key))
        catalog.set(key, { ref, name: project.name })
    }
    for (const ref of selected) {
      const key = projectRefKey(ref)
      if (!catalog.has(key)) catalog.set(key, { ref, name: ref.id })
    }
  }
  const needle = query.trim().toLocaleLowerCase()
  const visible = [...catalog.values()].filter(row => row.name.toLocaleLowerCase().includes(needle))
  const resetEditor = (next: ProjectScopeEditor = null) => {
    setEditor(next)
    setOpenedFromAdd(false)
    setQuery('')
    setRuleDraft(undefined)
  }
  useConnectionScopeBack(
    editor
      ? () => onBack(() => resetEditor(editor !== 'choose' && openedFromAdd ? 'choose' : null))
      : null
  )
  const changeRule = (next: ConnectionScopeRule) => {
    if (rule === next) return
    setRuleDraft(next)
    setQuery('')
    onChange({
      allProjects: next === 'all' || next === 'exclude',
      projects: next === 'include' ? source.projects : [],
      excludedProjects: next === 'exclude' ? source.excludedProjects : [],
    })
  }

  const triggerLabel = t('standIn.workspace.connection_trigger')
  const issueLabels = {
    includeParticipatingIssues: t('standIn.workspace.receive_participating_issues'),
    includeIndependentIssues: t('standIn.workspace.receive_independent_issues'),
  }
  const triggerPicker = (field: 'projectTrigger' | 'participatingTrigger', label: string) => (
    <ConnectionChoice<StandInProjectTrigger>
      label={label}
      value={source[field] ?? 'both'}
      options={triggerModes.map(value => ({
        value,
        label: t(`standIn.workspace.project_trigger_${value}`),
      }))}
      disabled={disabled}
      testId={`stand-in-project-${field}`}
      onChange={value => onChange({ [field]: value === 'both' ? undefined : value })}
    />
  )
  return (
    <div className="min-w-0 space-y-3" data-testid="stand-in-project-scope">
      {!editor && (
        <ConnectionScopeList
          disabled={disabled}
          empty={source.enabled ? undefined : t('standIn.workspace.connection_not_configured')}
          testId="stand-in-project-add-scope"
          onAdd={() => setEditor('choose')}
        >
          {(source.allProjects || source.projects.length > 0) && (
            <ConnectionScopeRow
              name={t(
                source.allProjects
                  ? 'standIn.workspace.project_only_all'
                  : 'standIn.workspace.project_rule_include'
              )}
              description={
                source.allProjects
                  ? source.excludedProjects.length
                    ? t('standIn.workspace.connection_excluded_count', {
                        count: source.excludedProjects.length,
                      })
                    : undefined
                  : projects
                      .filter(project =>
                        selectedKeys.has(
                          projectRefKey({
                            id: project.id,
                            store: project.project_store === 'local' ? 'local' : 'cloud',
                          })
                        )
                      )
                      .map(project => project.name)
                      .join('、')
              }
              testId="stand-in-project-open-scope-projects"
              onClick={() => setEditor('projects')}
              onRemove={() => onChange({ allProjects: false, projects: [], excludedProjects: [] })}
              disabled={disabled}
            />
          )}
          {issueKeys
            .filter(key => source[key])
            .map(key => (
              <ConnectionScopeRow
                key={key}
                name={issueLabels[key]}
                testId={`stand-in-project-open-scope-${key}`}
                onClick={() => setEditor(key)}
                onRemove={() => onChange({ [key]: false })}
                disabled={disabled}
              />
            ))}
        </ConnectionScopeList>
      )}
      {editor === 'choose' && (
        <ul className="divide-y divide-border">
          {!hasAllCollaborationSources(source) && (
            <ConnectionScopeRow
              name={t('standIn.workspace.project_scope_all')}
              description={t('standIn.workspace.project_scope_all_help')}
              testId="stand-in-all-projects"
              disabled={disabled}
              onClick={() => {
                onChange({
                  allProjects: true,
                  projects: [],
                  excludedProjects: [],
                  includeIndependentIssues: true,
                  includeParticipatingIssues: true,
                  projectTrigger: undefined,
                  participatingTrigger: undefined,
                })
                setOpenedFromAdd(true)
                setEditor('all')
              }}
            />
          )}
          <ConnectionScopeRow
            name={t('standIn.workspace.project_scope_projects_and_independent')}
            testId="stand-in-project-choose-projects"
            disabled={disabled}
            onClick={() => {
              setOpenedFromAdd(true)
              setEditor('projects')
            }}
          />
          {!source.includeParticipatingIssues && (
            <ConnectionScopeRow
              name={issueLabels.includeParticipatingIssues}
              description={t('standIn.workspace.receive_participating_issues_help')}
              testId="stand-in-participating-issues"
              disabled={disabled}
              onClick={() => {
                onChange({ includeParticipatingIssues: true })
                setOpenedFromAdd(true)
                setEditor('includeParticipatingIssues')
              }}
            />
          )}
        </ul>
      )}
      {editor === 'all' && (
        <p className="text-sm text-text-secondary">
          {t('standIn.workspace.project_scope_all_help')}
        </p>
      )}
      {editor === 'includeIndependentIssues' && (
        <ConnectionFixedTrigger
          label={triggerLabel}
          value={t('standIn.workspace.project_trigger_assigned')}
        />
      )}
      {editor === 'projects' && (
        <div className="min-w-0 space-y-3">
          <ConnectionChoice
            label={t('standIn.workspace.project_scope_question')}
            options={projectRules.map(value => ({
              value,
              label: t(`standIn.workspace.project_rule_${value}`),
            }))}
            value={rule}
            onChange={changeRule}
            disabled={disabled}
            testId="stand-in-project-list-mode"
          />
          <label className="flex min-h-11 items-start gap-2 rounded-md px-2 py-2 hover:bg-muted">
            <Checkbox
              className="mt-0.5"
              data-testid="stand-in-independent-issues"
              checked={source.includeIndependentIssues}
              disabled={disabled}
              onCheckedChange={checked => onChange({ includeIndependentIssues: checked === true })}
            />
            <span className="min-w-0 space-y-0.5 text-sm">
              <span className="block">{t('standIn.workspace.project_scope_independent')}</span>
              <span className="block text-xs text-text-secondary">
                {t('standIn.workspace.project_scope_independent_help')}
              </span>
            </span>
          </label>
          {isList && (
            <div className="space-y-2">
              <TextField
                data-testid="stand-in-search-project-scope"
                value={query}
                disabled={disabled}
                aria-label={t('standIn.workspace.connection_search_projects')}
                placeholder={t('standIn.workspace.connection_search_projects')}
                onChange={event => setQuery(event.target.value)}
                className="w-full"
              />
              <div
                className="max-h-40 min-w-0 overflow-y-auto"
                data-testid="stand-in-source-projects"
              >
                {visible.map(({ ref, name }) => {
                  const key = projectRefKey(ref)
                  return (
                    <label
                      key={key}
                      className={`flex min-h-11 items-center gap-2 rounded-md px-2 hover:bg-muted md:min-h-8 ${ref.id === focusedProjectId ? 'bg-muted' : ''}`}
                    >
                      <Checkbox
                        data-testid={`stand-in-connect-project-${ref.id}`}
                        aria-label={name}
                        checked={selectedKeys.has(key)}
                        disabled={disabled}
                        onCheckedChange={checked => {
                          const rows = selected.filter(row => projectRefKey(row) !== key)
                          if (checked) rows.push(ref)
                          onChange(
                            rule === 'exclude'
                              ? { excludedProjects: rows }
                              : { projects: rows, excludedProjects: [] }
                          )
                        }}
                      />
                      <span className="min-w-0 flex-1 break-words">{name}</span>
                      <span className="text-xs text-text-secondary">
                        {t(
                          ref.store === 'local'
                            ? 'standIn.personal.local'
                            : 'standIn.personal.cloud'
                        )}
                      </span>
                    </label>
                  )
                })}
                {!visible.length && (
                  <p className="py-2 text-sm text-text-secondary">
                    {t(
                      needle
                        ? 'standIn.workspace.no_connections_found'
                        : 'standIn.workspace.connection_projects_empty_selected'
                    )}
                  </p>
                )}
              </div>
            </div>
          )}
          {(source.allProjects || source.projects.length > 0) && (
            <>
              {onlyLocalProjects && source.projectTrigger !== 'mention' ? (
                <ConnectionFixedTrigger
                  label={t('standIn.workspace.project_intake_when')}
                  value={t('standIn.workspace.project_trigger_assigned')}
                />
              ) : (
                triggerPicker('projectTrigger', t('standIn.workspace.project_intake_when'))
              )}
              {onlyLocalProjects && source.projectTrigger === 'mention' && (
                <p className="text-xs text-text-secondary">
                  {t('standIn.workspace.project_trigger_local_mention_only')}
                </p>
              )}
              {!onlyLocalProjects &&
                allowLocalProjects &&
                (source.allProjects || source.projects.some(ref => ref.store === 'local')) && (
                  <p className="text-xs text-text-secondary">
                    {t('standIn.workspace.project_trigger_local_help')}
                  </p>
                )}
            </>
          )}
        </div>
      )}
      {editor === 'includeParticipatingIssues' && (
        <div className="space-y-2">
          {triggerPicker('participatingTrigger', triggerLabel)}
          <Button
            variant="outline"
            type="button"
            size="sm"
            disabled={disabled}
            data-testid="stand-in-project-remove-issue-scope"
            onClick={() => {
              onChange({ [editor]: false })
              resetEditor()
            }}
          >
            {t('standIn.workspace.connection_remove_scope')}
          </Button>
        </div>
      )}
    </div>
  )
}
