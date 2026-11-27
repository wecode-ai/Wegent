import type { StandInHandlingPolicy, StandInProjectRef, StandInRole } from '@/api/personalStandIn'
import { roleSelectsProject, standInPolicy } from '@/api/personalStandIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { SettingsSwitch } from '@/components/settings/settings-ui'
import type { AutomationNavigationHandle } from '@/features/automations/AutomationsPage'
import { useTranslation } from '@/hooks/useTranslation'
import type { CollaborationProject } from '@wegent/collaboration'
import { TagEditor, createTagDraft, type TagDraftStore } from '@wegent/collaboration'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import {
  CollapsiblePanel,
  CollapsibleRoot,
  CollapsibleTrigger,
} from '@wegent/collaboration/controls/Collapsible'
import { Folder } from 'lucide-react'
import { useImperativeHandle, useState, useSyncExternalStore, type Ref } from 'react'
import { StandInConnectionHeader } from './StandInConnectionHeader'
import { StandInProcessingSettings } from './StandInProcessingSettings'
import { useStandInPanelNavigation } from './useStandInPanelNavigation'

export interface StandInProjectNavigationHandle extends AutomationNavigationHandle {
  requestLeave(action: (discarded?: boolean) => void): void
}

/** Edit project intake scope, exclusions and handling policies for an independent stand-in. */
export function StandInConnections({
  role,
  projects,
  allowLocalProjects,
  onChange,
  disabled,
  focusedProjectId,
  ref: navigationRef,
  tagDraft: providedTagDraft,
}: {
  role: StandInRole
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
  const navigation = useStandInPanelNavigation(tagDraftDirty, disabled, () => setDiscard(true))
  useImperativeHandle(navigationRef, () => ({
    requestLeave(action) {
      navigation.requestLeave(() => action(tagDraftDirty))
    },
  }))
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
      <label className="flex min-h-11 items-center justify-between gap-3 text-sm md:min-h-9">
        <span>{t('standIn.workspace.receive_project_items')}</span>
        <SettingsSwitch
          data-testid="stand-in-source-collaboration"
          checked={source.enabled}
          disabled={disabled}
          onCheckedChange={enabled => navigation.requestLeave(() => setSource({ enabled }))}
          aria-label={t('standIn.personal.collaboration')}
        />
      </label>
      <fieldset disabled={disabled || !source.enabled} className="min-w-0 max-w-full space-y-4">
        <legend className="mb-2 text-sm font-medium">
          {t('standIn.workspace.connection_scope')}
        </legend>
        <label className="flex min-h-11 items-start gap-3 md:min-h-9">
          <Checkbox
            className="mt-1 accent-text-primary"
            data-testid="stand-in-participating-issues"
            checked={source.includeParticipatingIssues === true}
            onCheckedChange={checked => setSource({ includeParticipatingIssues: checked === true })}
          />
          <span>
            {t('standIn.workspace.receive_participating_issues')}
            <span className="mt-1 block text-xs text-text-secondary">
              {t('standIn.workspace.receive_participating_issues_help')}
            </span>
          </span>
        </label>
        <label className="flex min-h-11 items-start gap-3 md:min-h-9">
          <Checkbox
            className="mt-1 accent-text-primary"
            data-testid="stand-in-independent-issues"
            checked={source.includeIndependentIssues === true}
            disabled={disabled}
            onCheckedChange={checked => setSource({ includeIndependentIssues: checked === true })}
          />
          <span>{t('standIn.workspace.receive_independent_issues')}</span>
        </label>
        <label className="flex min-h-11 items-start gap-3 md:min-h-9">
          <Checkbox
            className="mt-1 accent-text-primary"
            data-testid="stand-in-all-projects"
            checked={source.allProjects}
            disabled={disabled}
            onCheckedChange={checked => setSource({ allProjects: checked === true })}
          />
          <span>
            {t('standIn.personal.all_projects')}
            <span className="mt-1 block text-xs text-text-secondary">
              {t('standIn.personal.all_projects_help')}
            </span>
          </span>
        </label>
        <div
          className="min-w-0 max-w-full max-h-64 overflow-y-auto divide-y divide-border/50"
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
                className={`flex min-h-11 min-w-0 items-center gap-3 rounded-md px-2 md:min-h-9 ${project.id === focusedProjectId ? 'bg-muted' : ''}`}
              >
                <label className="flex min-h-11 min-w-0 flex-1 items-center gap-3 md:min-h-9">
                  <Checkbox
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
                    onCheckedChange={checked => toggleProject(project, checked === true)}
                  />
                  <span className="min-w-0 flex-1 break-words">{project.name}</span>
                  <span className="shrink-0 text-xs text-text-secondary">
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
            <p className="py-3 text-text-secondary">
              {t(
                source.allProjects
                  ? 'standIn.workspace.connection_projects_empty_all'
                  : 'standIn.workspace.connection_projects_empty_selected'
              )}
            </p>
          )}
        </div>
        <CollapsibleRoot
          className="group border-t border-border pt-3"
          defaultOpen={source.tags.length ? true : undefined}
        >
          <CollapsibleTrigger
            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/70"
            data-testid="stand-in-source-tags-toggle"
          >
            <span className="min-w-0 flex-1 font-medium">{t('standIn.personal.limit_tags')}</span>
            <span className="rounded-md border border-border bg-background px-2 py-1">
              <span className="group-data-[open]:hidden">
                {t('standIn.workspace.processing_edit')}
              </span>
              <span className="hidden group-data-[open]:inline">
                {t('standIn.workspace.processing_hide')}
              </span>
            </span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="mt-2 rounded-md border border-border p-2">
              <TagEditor
                key={draftVersion}
                tags={source.tags}
                onChange={tags => setSource({ tags })}
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
              {t('standIn.personal.limit_tags_help')}
            </p>
          </CollapsiblePanel>
        </CollapsibleRoot>
      </fieldset>
      {tagDraftDirty && (
        <p
          role="status"
          className="text-sm text-text-secondary"
          data-testid="stand-in-project-tags-draft-help"
        >
          {t('standIn.workspace.tag_draft_help')}
        </p>
      )}
      <StandInProcessingSettings
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
