import type {
  StandInHandlingPolicy,
  StandInProjectRef,
  StandInProjectScopeKind,
  StandInRole,
} from '@/api/personalStandIn'
import { roleSelectsProject, standInPolicy, standInProjectTags } from '@/api/personalStandIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import type { AutomationNavigationHandle } from '@/features/automations/AutomationsPage'
import { useTranslation } from '@/hooks/useTranslation'
import type { CollaborationProject } from '@wegent/collaboration'
import { TagEditor, createTagDraft, type TagDraftStore } from '@wegent/collaboration'
import {
  CollapsiblePanel,
  CollapsibleRoot,
  CollapsibleTrigger,
} from '@wegent/collaboration/controls/Collapsible'
import {
  useImperativeHandle,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from 'react'
import { StandInProjectScope, type ProjectScopeEditor } from './StandInProjectScope'
import {
  effectiveProjectSource,
  projectRefKey,
  updateProjectSource,
  type ProjectSource,
} from './standInProjects'
import { StandInConnectionForm } from './StandInConnectionForm'
import { ConnectionChoice } from './ConnectionScopeFields'
import { StandInProcessingSettings } from './StandInProcessingSettings'
import { useStandInPanelNavigation } from './useStandInPanelNavigation'

export interface StandInProjectNavigationHandle extends AutomationNavigationHandle {
  requestLeave(action: (discarded?: boolean) => void): void
}

type TagTarget = { value: string; label: string } & (
  | { scope: StandInProjectScopeKind; project?: never }
  | { scope?: never; project: StandInProjectRef }
)

/** Edit project intake scope, exclusions and handling policies for an independent stand-in. */
export function StandInConnections({
  role,
  savedSource,
  account,
  projects,
  allowLocalProjects,
  onChange,
  disabled,
  focusedProjectId,
  ref: navigationRef,
  tagDraft: providedTagDraft,
}: {
  role: StandInRole
  savedSource?: ProjectSource
  account: ReactNode
  projects: CollaborationProject[]
  allowLocalProjects: boolean
  onChange(role: StandInRole): void
  disabled: boolean
  focusedProjectId?: string
  ref?: Ref<StandInProjectNavigationHandle>
  tagDraft?: TagDraftStore
}) {
  const { t } = useTranslation('common')
  const [ownedTagDraft] = useState(createTagDraft)
  const tagDraft = providedTagDraft ?? ownedTagDraft
  const tagDraftDirty = useSyncExternalStore(
    tagDraft.subscribe,
    tagDraft.getDirtySnapshot,
    tagDraft.getDirtySnapshot
  )
  const [discard, setDiscard] = useState(false)
  const [draftVersion, setDraftVersion] = useState(0)
  const [scopeEditor, setScopeEditor] = useState<ProjectScopeEditor>(null)
  const [selectedTagScope, setSelectedTagScope] = useState('')
  const navigation = useStandInPanelNavigation(tagDraftDirty, disabled, () => setDiscard(true))
  useImperativeHandle(navigationRef, () => ({
    requestLeave(action) {
      navigation.requestLeave(() => action(tagDraftDirty))
    },
  }))
  const source = role.collaboration
  const scope = effectiveProjectSource(source)
  const hasProjects = scope.allProjects || scope.projects.length > 0
  const tagScopes: StandInProjectScopeKind[] = []
  if ((scopeEditor === 'all' || scopeEditor === 'projects') && hasProjects) {
    tagScopes.push('projects')
  }
  if (
    (scopeEditor === 'all' || scopeEditor === 'includeParticipatingIssues') &&
    scope.includeParticipatingIssues
  ) {
    tagScopes.push('participating')
  }
  if (
    (scopeEditor === 'all' ||
      scopeEditor === 'projects' ||
      scopeEditor === 'includeIndependentIssues') &&
    scope.includeIndependentIssues
  ) {
    tagScopes.push('independent')
  }
  const tagScopeLabels: Record<StandInProjectScopeKind, string> = {
    projects: t('standIn.workspace.project_only_all'),
    participating: t('standIn.workspace.receive_participating_issues'),
    independent: t('standIn.workspace.project_scope_independent'),
  }
  const excluded = new Set(scope.excludedProjects.map(projectRefKey))
  const ref = (project: CollaborationProject): StandInProjectRef => ({
    id: project.id,
    store: project.project_store === 'local' ? 'local' : 'cloud',
  })
  const projectNames = new Map(projects.map(project => [projectRefKey(ref(project)), project.name]))
  const tagTargets: TagTarget[] = tagScopes.flatMap((kind): TagTarget[] => {
    const group: TagTarget = { value: kind, label: tagScopeLabels[kind], scope: kind }
    if (kind !== 'projects') return [group]
    const projectRefs = scope.allProjects ? (scope.projectTagFilters ?? []) : scope.projects
    return [
      ...(scope.allProjects ? [group] : []),
      ...projectRefs
        .filter(project => !excluded.has(projectRefKey(project)))
        .map(project => {
          const value = projectRefKey(project)
          return {
            value,
            label: projectNames.get(value) ?? t('standIn.workspace.unavailable_project'),
            project: { id: project.id, store: project.store },
          }
        }),
    ]
  })
  const tagTarget = tagTargets.find(target => target.value === selectedTagScope) ?? tagTargets[0]
  const tags = tagTarget?.project
    ? standInProjectTags(scope, tagTarget.project)
    : tagTarget
      ? (scope.tagFilters?.[tagTarget.scope] ?? scope.tags)
      : []
  const setSource = (patch: Partial<ProjectSource>) => {
    onChange({ ...role, collaboration: updateProjectSource(source, patch, savedSource) })
  }
  const savedScope = savedSource && effectiveProjectSource(savedSource)
  const restoreScope = (
    target: 'projects' | 'includeParticipatingIssues' | 'includeIndependentIssues'
  ) => {
    if (!savedScope) return
    const restored =
      target === 'projects'
        ? {
            ...scope,
            allProjects: savedScope.allProjects,
            projects: savedScope.projects,
            excludedProjects: savedScope.excludedProjects,
            projectTagFilters: savedScope.projectTagFilters,
          }
        : { ...scope, [target]: savedScope[target] }
    onChange({ ...role, collaboration: updateProjectSource(restored, {}, savedSource) })
  }
  const updateTags = (target: TagTarget, tags: string[]) => {
    if (target.project) {
      setSource({
        projectTagFilters: [
          ...(scope.projectTagFilters ?? []).filter(row => projectRefKey(row) !== target.value),
          { ...target.project, tags },
        ],
      })
      return
    }
    setSource({ tagFilters: { ...scope.tagFilters, [target.scope]: tags } })
  }
  return (
    <div className="space-y-4" data-testid="stand-in-connections">
      <StandInConnectionForm
        compact
        account={account}
        scope={
          <StandInProjectScope
            source={scope}
            savedSource={savedScope}
            projects={projects}
            allowLocalProjects={allowLocalProjects}
            focusedProjectId={focusedProjectId}
            disabled={disabled}
            editor={scopeEditor}
            setEditor={editor => {
              setScopeEditor(editor)
              setSelectedTagScope('')
            }}
            protectTagDraft={navigation.requestLeave}
            onChange={setSource}
            onRestore={restoreScope}
          />
        }
        extra={
          tagTarget && (
            <>
              <CollapsibleRoot defaultOpen={tags.length > 0}>
                <CollapsibleTrigger
                  className="flex min-h-11 items-center gap-2 rounded-md text-sm text-text-secondary hover:text-text-primary md:min-h-7"
                  data-testid="stand-in-source-tags-toggle"
                >
                  <span className="min-w-0 flex-1 font-medium">
                    {tagTargets.length === 1
                      ? t('standIn.workspace.project_range_tags', { name: tagTarget.label })
                      : t('standIn.workspace.project_filter_tags')}
                  </span>
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  {tagTargets.length > 1 && (
                    <ConnectionChoice
                      label={t('standIn.workspace.project_tag_scope')}
                      value={tagTarget.value}
                      options={tagTargets}
                      disabled={disabled || tagDraftDirty}
                      testId="stand-in-project-tag-scope"
                      onChange={setSelectedTagScope}
                    />
                  )}
                  <div className="mt-2 rounded-md border border-border p-2">
                    <TagEditor
                      key={`${tagTarget.value}:${draftVersion}`}
                      tags={tags}
                      onChange={tags => updateTags(tagTarget, tags)}
                      draftStore={tagDraft}
                      disabled={disabled}
                      suggestions={[...new Set(projects.flatMap(project => project.tags ?? []))]}
                      placeholder={t('standIn.personal.add_tag')}
                      lengthErrorLabel={t('standIn.personal.tag_too_long')}
                      removeLabel={tag => t('standIn.personal.remove_tag', { tag })}
                      testIdPrefix="stand-in-connection-tags"
                    />
                  </div>
                  <p className="mt-2 text-xs text-text-secondary">
                    {t('standIn.workspace.project_scope_tags_help')}
                  </p>
                </CollapsiblePanel>
              </CollapsibleRoot>
              {tagDraftDirty && (
                <p
                  role="status"
                  className="text-sm text-text-secondary"
                  data-testid="stand-in-project-tags-draft-help"
                >
                  {t('standIn.workspace.tag_draft_help')}
                </p>
              )}
            </>
          )
        }
        processing={
          tagScopes.length > 0 && (
            <StandInProcessingSettings
              compact
              disabled={disabled}
              sessionScope="issue"
              rows={[
                {
                  key: 'default',
                  name: t('standIn.workspace.default_processing'),
                  testId: 'stand-in-project-default-policy',
                  policy: standInPolicy(role),
                  onChange: (policy: StandInHandlingPolicy) => setSource({ policy }),
                },
                ...projects
                  .filter(
                    project =>
                      tagScopes.includes('projects') &&
                      roleSelectsProject({ collaboration: scope }, ref(project))
                  )
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
          )
        }
      />
      <ConfirmDialog
        open={discard}
        title={t('standIn.personal.discard_help')}
        description={t('standIn.personal.discard_description')}
        cancelLabel={t('standIn.personal.keep_editing')}
        confirmLabel={t('standIn.personal.discard')}
        confirmTestId="stand-in-project-tags-discard"
        cancelTestId="stand-in-project-tags-keep-editing"
        destructive
        onClose={() => {
          navigation.cancelLeave()
          setDiscard(false)
        }}
        onConfirm={() => {
          setDiscard(false)
          tagDraft.set('')
          setDraftVersion(value => value + 1)
          navigation.confirmLeave(() => {})
        }}
      />
    </div>
  )
}
