import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { SquarePen, AlertTriangle, CircleCheck, Search, ChevronRight } from 'lucide-react'
import { createCollaborationTranslator, type CollaborationLocale } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject, CollaborationWorkspace } from '../types'
import type { ComposerInputHandle } from '../composer'
import { IssueExecutionEnvironmentNotice } from '../execution-environment/IssueExecutionEnvironmentNotice'
import { useProjectExecutionEnvironmentReadiness } from '../execution-environment/issueEnvironmentReadiness'
import { IssueHomeComposer } from './IssueHomeComposer'
import type { IssueHomeOwner } from './issueHomeOwners'
import type { CollaborationPlatformHostAdapter } from './types'
import type { PlatformMessages } from './platformMessages'

const subscribeLocalDraft = () => () => {}

export function IssueHomeLauncher({
  draft,
  messages,
  projects,
  workspaces,
  selectedProjectId,
  onSelectProject,
  onCreateIssue,
  onOpenExecutionEnvironments,
  pending,
  api,
  locale,
  renderTaskComposer,
  currentUserId,
}: {
  draft?: CollaborationPlatformHostAdapter['issueHomeDraft']
  currentUserId?: number
  messages: PlatformMessages
  projects: CollaborationProject[]
  workspaces: CollaborationWorkspace[]
  selectedProjectId: string
  onSelectProject(projectId: string): void
  onCreateIssue(
    content: string,
    owner: IssueHomeOwner | null,
    files: File[],
    standInDeviceId?: string,
    standInId?: string
  ): Promise<boolean>
  onOpenExecutionEnvironments(project: CollaborationProject): void
  pending: boolean
  api: SharedWorkspaceApi
  locale: CollaborationLocale
  renderTaskComposer?: CollaborationPlatformHostAdapter['renderIssueComposer']
}) {
  const [localContent, setLocalContent] = useState('')
  const readContent = () => draft?.value ?? localContent
  const content = useSyncExternalStore(
    draft?.subscribe ?? subscribeLocalDraft,
    readContent,
    readContent
  )
  const contentRevision = draft?.getRevision()
  const setContent = draft?.onChange ?? setLocalContent
  const composerRef = useRef<ComposerInputHandle>(null)
  const selectedProject = projects.find(project => project.id === selectedProjectId)
  const translate = useMemo(() => createCollaborationTranslator(locale), [locale])
  const environmentReadiness = useProjectExecutionEnvironmentReadiness({
    api,
    project: selectedProject,
  })
  const participants = useMemo(
    () =>
      createAsyncResource(
        selectedProjectId,
        async () => {
          const [members, agents, groups] = await Promise.all([
            api.members.list(selectedProjectId),
            api.agents.list(selectedProjectId),
            api.projects.listCollaborationGroups?.(selectedProjectId) ?? [],
          ])
          return { members, agents, groups }
        },
        { refreshOnSubscribe: true }
      ),
    [api, selectedProjectId]
  )
  const participantSnapshot = useSyncExternalStore(
    participants.subscribe,
    participants.getSnapshot,
    participants.getSnapshot
  )
  const references = useMemo(
    () =>
      createAsyncResource(selectedProjectId, () => api.issues.list(selectedProjectId), {
        refreshOnSubscribe: true,
      }),
    [api, selectedProjectId]
  )
  const needsIssueReferences = content.includes('#')
  const subscribeReferences = useCallback(
    (listener: () => void) => (needsIssueReferences ? references.subscribe(listener) : () => {}),
    [needsIssueReferences, references]
  )
  const referenceSnapshot = useSyncExternalStore(
    subscribeReferences,
    references.getSnapshot,
    references.getSnapshot
  )
  const members = participantSnapshot.data?.members ?? []
  const agents = participantSnapshot.data?.agents ?? []
  const mentionGroups = participantSnapshot.data?.groups ?? []
  const mentionIssues = referenceSnapshot.data ?? []
  const memberError =
    participantSnapshot.status === 'error' ? messages.issueHomeMembersFailed : null
  const issueReferenceError =
    needsIssueReferences && referenceSnapshot.status === 'error'
      ? messages.issueHomeMembersFailed
      : null
  const guides = [
    {
      Icon: SquarePen,
      title: messages.issueGuideRequirement,
      hint: messages.issueGuideRequirementHint,
    },
    {
      Icon: AlertTriangle,
      title: messages.issueGuideBug,
      hint: messages.issueGuideBugHint,
    },
    {
      Icon: CircleCheck,
      title: messages.issueGuideReview,
      hint: messages.issueGuideReviewHint,
    },
    {
      Icon: Search,
      title: messages.issueGuideResearch,
      hint: messages.issueGuideResearchHint,
    },
  ]

  const composer = (
    <IssueHomeComposer
      renderTaskComposer={renderTaskComposer}
      currentUserId={currentUserId}
      ref={composerRef}
      value={content}
      onChange={value => {
        if (!value && draft && draft.getRevision() !== contentRevision) return
        setContent(value)
      }}
      onSubmit={onCreateIssue}
      pending={pending}
      members={members}
      agents={agents}
      issues={mentionIssues}
      groups={mentionGroups}
      projects={projects}
      workspaces={workspaces}
      projectId={selectedProjectId}
      onSelectProject={onSelectProject}
      translate={translate}
      placeholder={messages.issueHomePlaceholder}
      projectLabel={messages.issueHomeProject}
      memberLabel={messages.members}
      error={memberError ?? issueReferenceError}
      environmentNotice={
        selectedProject ? (
          <IssueExecutionEnvironmentNotice
            canManage={
              selectedProject.access_role === 'Owner' ||
              selectedProject.access_role === 'Maintainer'
            }
            onOpenEnvironmentSettings={() => onOpenExecutionEnvironments(selectedProject)}
            readiness={environmentReadiness}
            translate={translate}
          />
        ) : null
      }
    />
  )
  if (renderTaskComposer)
    return (
      <div
        className="flex min-h-0 min-w-0 max-w-full flex-1"
        data-testid="collaboration-issue-home"
        data-execution-environment-readiness={environmentReadiness.kind}
      >
        {composer}
      </div>
    )

  return (
    <section
      className="collaboration-issue-home"
      data-testid="collaboration-issue-home"
      data-execution-environment-readiness={environmentReadiness.kind}
    >
      <div className="collaboration-issue-home-heading">
        <h1 data-testid="collaboration-issue-home-title">{messages.issueHomeTitle}</h1>
        <p data-testid="collaboration-issue-home-hint">{messages.issueHomeHint}</p>
      </div>
      <div className="collaboration-issue-home-guides">
        {guides.map((guide, index) => (
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={`collaboration-issue-guide-${index + 1}`}
            key={guide.title}
            title={guide.hint}
            disabled={pending}
            onClick={() => {
              const current = composerRef.current?.getValue() ?? content
              const next = `${current ? `${current}\n` : ''}${guide.title}：${guide.hint}`
              composerRef.current?.setValue(next)
              composerRef.current?.focus()
            }}
          >
            <guide.Icon aria-hidden="true" />
            <strong>{guide.title}</strong>
            <ChevronRight aria-hidden="true" />
          </ControlButton>
        ))}
      </div>
      <div className="collaboration-issue-home-composer">{composer}</div>
    </section>
  )
}
