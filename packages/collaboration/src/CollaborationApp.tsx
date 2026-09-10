// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState, type FormEvent } from 'react'

import { CollaborationBoard } from './CollaborationBoard'
import { collaborationMessages, type CollaborationLocale } from './i18n'
import { collaborationTestIds } from './testIds'
import { CollaborationSettings } from './CollaborationSettings'
import { IssueDetail } from './IssueDetail'
import { CollaborationFilesAdapter } from './web-adapter/CollaborationFilesAdapter'
import { MyWorkAdapter } from './web-adapter/MyWorkAdapter'
import { WorkspaceProjectsHomeAdapter } from './web-adapter/WorkspaceProjectsHomeAdapter'
import {
  ProjectViewSwitcher,
  type CollaborationProjectViewOption,
} from './workspace-header/ProjectViewSwitcher'
import type {
  CollaborationAttachment,
  CollaborationComment,
  CollaborationHostAdapter,
  CollaborationIssue,
  CollaborationMember,
  CollaborationPriority,
  CollaborationProject,
  CollaborationStatus,
  CollaborationView,
} from './types'
import type { SharedWorkspaceApi } from './ports/SharedWorkspaceApi'
import type { WorkspaceMyWorkItem } from './ports/SharedWorkspaceApi'

const DEFAULT_STATUSES: CollaborationStatus[] = [
  { id: 'pending', name: '待处理', color: 'gray' },
  { id: 'in_progress', name: '进行中', color: 'blue' },
  { id: 'completed', name: '已完成', color: 'green' },
]

export const collaborationProjectViewIds = ['board', 'files', 'automation', 'manage'] as const

interface CollaborationAppProps {
  api: SharedWorkspaceApi
  host: CollaborationHostAdapter
  locale?: CollaborationLocale
  pollIntervalMs?: number
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) return null
  return typeof error.status === 'number' ? error.status : null
}

function projectStatuses(project: CollaborationProject): CollaborationStatus[] {
  const statuses = project.board_config?.statuses
  return statuses && statuses.length > 0 ? statuses : DEFAULT_STATUSES
}

export function CollaborationApp({
  api,
  host,
  locale = 'zh-CN',
  pollIntervalMs = 15_000,
}: CollaborationAppProps) {
  const messages = collaborationMessages[locale]
  const [projects, setProjects] = useState<CollaborationProject[]>([])
  const [myWork, setMyWork] = useState<WorkspaceMyWorkItem[]>([])
  const [projectItems, setProjectItems] = useState<Record<string, CollaborationIssue[]>>({})
  const [projectMembers, setProjectMembers] = useState<Record<string, CollaborationMember[]>>({})
  const [project, setProject] = useState<CollaborationProject | null>(null)
  const [issues, setIssues] = useState<CollaborationIssue[]>([])
  const [selectedIssue, setSelectedIssue] = useState<CollaborationIssue | null>(null)
  const [attachments, setAttachments] = useState<CollaborationAttachment[]>([])
  const [comments, setComments] = useState<CollaborationComment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [createIssueOpen, setCreateIssueOpen] = useState(false)

  const notify = useCallback(
    (message: string, kind: 'success' | 'error' = 'error') => {
      host.notify?.(message, kind)
      if (kind === 'error') setError(message)
    },
    [host]
  )

  const loadProjects = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const nextProjects = await api.projects.list()
      const snapshots = await Promise.all(
        nextProjects.map(async nextProject => ({
          projectId: nextProject.id,
          snapshot: await api.issues.getBoardSnapshot(nextProject.id),
        }))
      )
      setProjects(nextProjects)
      setProjectItems(
        Object.fromEntries(snapshots.map(({ projectId, snapshot }) => [projectId, snapshot.items]))
      )
      setProjectMembers(
        Object.fromEntries(
          snapshots.map(({ projectId, snapshot }) => [projectId, snapshot.members])
        )
      )
    } catch {
      setError(messages.loadFailed)
    } finally {
      setLoading(false)
    }
  }, [api, messages.loadFailed])

  const loadProject = useCallback(
    async (projectId: string, showLoading = true) => {
      if (showLoading) setLoading(true)
      try {
        const [nextProject, snapshot] = await Promise.all([
          api.projects.get(projectId),
          api.issues.getBoardSnapshot(projectId),
        ])
        setProject(nextProject)
        setIssues(snapshot.items)
        setError(null)
      } catch {
        setError(messages.loadFailed)
      } finally {
        if (showLoading) setLoading(false)
      }
    },
    [api, messages.loadFailed]
  )

  const loadMyWork = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setMyWork(await api.projects.listMyWork())
    } catch {
      setError(messages.loadFailed)
    } finally {
      setLoading(false)
    }
  }, [api, messages.loadFailed])

  useEffect(() => {
    if (host.location.projectId) {
      void loadProject(host.location.projectId)
    } else if (host.location.rootView === 'my-work') {
      setProject(null)
      setSelectedIssue(null)
      void loadMyWork()
    } else {
      setProject(null)
      setSelectedIssue(null)
      void loadProjects()
    }
  }, [host.location.projectId, host.location.rootView, loadMyWork, loadProject, loadProjects])

  useEffect(() => {
    const projectId = host.location.projectId
    if (!projectId || pollIntervalMs <= 0) return
    const timer = window.setInterval(() => void loadProject(projectId, false), pollIntervalMs)
    return () => window.clearInterval(timer)
  }, [host.location.projectId, loadProject, pollIntervalMs])

  useEffect(() => {
    const issueId = host.location.issueId
    if (!issueId) {
      setSelectedIssue(null)
      setAttachments([])
      setComments([])
      return
    }
    void Promise.all([
      api.issues.get(issueId),
      api.attachments.list(issueId),
      api.comments.list(issueId),
    ])
      .then(([issue, nextAttachments, nextComments]) => {
        setSelectedIssue(issue)
        setAttachments(nextAttachments)
        setComments(nextComments)
      })
      .catch(() => setError(messages.loadFailed))
  }, [api, host.location.issueId, messages.loadFailed])

  const navigateView = (view: CollaborationView) => {
    host.navigate({ projectId: project?.id ?? null, issueId: null, view })
  }

  if (loading) {
    return (
      <div className="collaboration-loading" data-testid={collaborationTestIds.root}>
        {messages.loading}
      </div>
    )
  }

  return (
    <section className="collaboration-app" data-testid={collaborationTestIds.root}>
      {error && (
        <div className="collaboration-alert" role="alert" data-testid="collaboration-error">
          {error}
        </div>
      )}
      {!project && host.location.rootView === 'my-work' ? (
        <MyWorkAdapter
          items={myWork}
          locale={locale}
          onBack={() =>
            host.navigate({
              projectId: null,
              issueId: null,
              view: 'board',
              rootView: 'home',
            })
          }
          onSelectItem={item =>
            host.navigate({
              projectId: item.cloud_project_id,
              issueId: item.id,
              view: 'board',
            })
          }
        />
      ) : !project ? (
        <WorkspaceProjectsHomeAdapter
          projects={projects}
          projectItems={projectItems}
          projectMembers={projectMembers}
          onCreateProject={() => setCreateProjectOpen(true)}
          onSelectProject={nextProject =>
            host.navigate({
              projectId: nextProject.id,
              issueId: null,
              view: 'board',
            })
          }
          onManageProject={nextProject =>
            host.navigate({
              projectId: nextProject.id,
              issueId: null,
              view: 'manage',
            })
          }
          onOpenMyWork={() =>
            host.navigate({
              projectId: null,
              issueId: null,
              view: 'board',
              rootView: 'my-work',
            })
          }
          onUnavailable={() => notify(messages.capabilitiesUnavailable)}
        />
      ) : (
        <>
          <header className="collaboration-project-header">
            <button
              type="button"
              className="collaboration-link-button"
              data-testid="collaboration-project-back"
              onClick={() => host.navigate({ projectId: null, issueId: null, view: 'board' })}
            >
              ← {messages.back}
            </button>
            <div>
              <span className="collaboration-project-key">{project.project_key}</span>
              <h1>{project.name}</h1>
              {project.description && <p>{project.description}</p>}
            </div>
            <button
              type="button"
              className="collaboration-primary-button"
              data-testid={collaborationTestIds.createIssue}
              onClick={() => setCreateIssueOpen(true)}
            >
              {messages.createIssue}
            </button>
            {host.projectActions?.map(action => (
              <button
                type="button"
                className="collaboration-secondary-button"
                data-testid={action.testId}
                key={action.id}
                onClick={() => action.invoke(project)}
              >
                {action.renderIcon?.()}
                {action.label}
              </button>
            ))}
          </header>
          <div className="mb-5">
            <ProjectViewSwitcher
              ariaLabel={messages.title}
              compact={false}
              value={host.location.view}
              options={collaborationProjectViewIds
                .filter(view => view !== 'automation' || host.capabilities.automation)
                .map(
                  view =>
                    ({
                      id: view,
                      label:
                        view === 'board'
                          ? messages.board
                          : view === 'files'
                            ? messages.files
                            : view === 'automation'
                              ? messages.automation
                              : messages.settings,
                      testId: `collaboration-tab-${view}`,
                    }) satisfies CollaborationProjectViewOption
                )}
              onChange={view => navigateView(view as CollaborationView)}
            />
          </div>
          {host.location.view === 'board' && (
            <CollaborationBoard
              project={project}
              issues={issues}
              statuses={projectStatuses(project)}
              labels={{
                noIssues: messages.noIssues,
                search: messages.searchIssues,
                groupBy: messages.groupBy,
                groupStatus: messages.groupStatus,
                groupPriority: messages.groupPriority,
                groupAssignee: messages.groupAssignee,
                groupTag: messages.groupTag,
                unassigned: messages.unassigned,
                noTag: messages.noTag,
              }}
              onOpen={issue =>
                host.navigate({
                  projectId: project.id,
                  issueId: issue.id,
                  view: 'board',
                })
              }
              onReorder={async (issue, status, laneIds, optimisticItems) => {
                try {
                  setIssues(optimisticItems)
                  const updated = await api.issues.reorder(project.id, {
                    parentId: issue.parent_id,
                    status,
                    issueIds: laneIds,
                  })
                  const updatedById = new Map(updated.map(item => [item.id, item]))
                  setIssues(current => current.map(item => updatedById.get(item.id) ?? item))
                } catch (moveError) {
                  if (errorStatus(moveError) === 409) {
                    await loadProject(project.id, false)
                    notify(messages.conflict)
                  } else {
                    notify(messages.saveFailed)
                  }
                }
              }}
              onGroupByChange={async groupBy => {
                const currentConfig = project.board_config ?? {
                  group_by: 'status' as const,
                  processing_start_status_id: projectStatuses(project)[1]?.id ?? null,
                  statuses: projectStatuses(project),
                }
                setProject({
                  ...project,
                  board_config: { ...currentConfig, group_by: groupBy },
                })
                try {
                  setProject(
                    await api.projects.update(project.id, {
                      version: project.version,
                      boardConfig: { ...currentConfig, group_by: groupBy },
                    })
                  )
                } catch (updateError) {
                  if (errorStatus(updateError) === 409) await loadProject(project.id, false)
                  else setProject(project)
                  notify(messages.saveFailed)
                }
              }}
            />
          )}
          {host.location.view === 'files' && (
            <CollaborationFilesAdapter api={api.files} project={project} />
          )}
          {host.location.view === 'automation' && (
            <CapabilityView
              title={messages.automation}
              unavailable={!host.capabilities.automation}
              unavailableMessage={messages.capabilitiesUnavailable}
            />
          )}
          {host.location.view === 'manage' && (
            <CollaborationSettings
              api={api}
              project={project}
              onChange={setProject}
              onError={() => notify(messages.saveFailed)}
            />
          )}
        </>
      )}
      {createProjectOpen && (
        <CreateProjectDialog
          allowLocalProjects={host.capabilities.localProjects}
          messages={messages}
          onClose={() => setCreateProjectOpen(false)}
          onCreate={async values => {
            try {
              const created = await api.projects.create({
                name: values.name,
                description: values.description,
              })
              setCreateProjectOpen(false)
              host.navigate({
                projectId: created.id,
                issueId: null,
                view: 'board',
              })
            } catch {
              notify(messages.saveFailed)
            }
          }}
        />
      )}
      {createIssueOpen && project && (
        <CreateIssueDialog
          statuses={projectStatuses(project)}
          messages={messages}
          onClose={() => setCreateIssueOpen(false)}
          onCreate={async values => {
            try {
              const created = await api.issues.create(project.id, values)
              setIssues(current => [...current, created])
              setCreateIssueOpen(false)
              host.navigate({
                projectId: project.id,
                issueId: created.id,
                view: 'board',
              })
            } catch {
              notify(messages.saveFailed)
            }
          }}
        />
      )}
      {selectedIssue && project && (
        <IssueDetail
          api={api}
          issue={selectedIssue}
          statuses={projectStatuses(project)}
          attachments={attachments}
          comments={comments}
          messages={messages}
          onClose={() =>
            host.navigate({
              projectId: project.id,
              issueId: null,
              view: host.location.view,
            })
          }
          onChange={updated => {
            setSelectedIssue(updated)
            setIssues(current => current.map(item => (item.id === updated.id ? updated : item)))
          }}
          onAttachmentsChange={setAttachments}
          onCommentsChange={setComments}
          onConflict={async () => {
            const current = await api.issues.get(selectedIssue.id)
            setSelectedIssue(current)
            setIssues(items => items.map(item => (item.id === current.id ? current : item)))
            notify(messages.conflict)
          }}
          onError={() => notify(messages.saveFailed)}
        />
      )}
    </section>
  )
}

type Messages = (typeof collaborationMessages)['zh-CN'] | (typeof collaborationMessages)['en']

function DialogFrame({
  testId,
  title,
  children,
}: {
  testId: string
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="collaboration-dialog-backdrop">
      <div className="collaboration-dialog" role="dialog" aria-modal="true" data-testid={testId}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

function CreateProjectDialog({
  allowLocalProjects,
  messages,
  onClose,
  onCreate,
}: {
  allowLocalProjects: boolean
  messages: Messages
  onClose(): void
  onCreate(values: {
    name: string
    description: string
    project_store?: 'local' | 'backend'
  }): Promise<void>
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [projectStore, setProjectStore] = useState<'local' | 'backend'>('backend')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (name.trim()) {
      void onCreate({
        name: name.trim(),
        description: description.trim(),
        ...(allowLocalProjects ? { project_store: projectStore } : {}),
      })
    }
  }
  return (
    <DialogFrame testId={collaborationTestIds.createProjectDialog} title={messages.createProject}>
      <form onSubmit={submit}>
        <label>
          {messages.projectName}
          <input
            data-testid="collaboration-project-name-input"
            value={name}
            onChange={event => setName(event.target.value)}
            autoFocus
          />
        </label>
        <label>
          {messages.projectDescription}
          <textarea
            data-testid="collaboration-project-description-input"
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </label>
        {allowLocalProjects && (
          <fieldset className="collaboration-project-location">
            <legend>{messages.projectLocation}</legend>
            <label>
              <input
                type="radio"
                name="collaboration-project-location"
                value="backend"
                data-testid="collaboration-project-location-cloud"
                checked={projectStore === 'backend'}
                onChange={() => setProjectStore('backend')}
              />
              {messages.cloudProject}
            </label>
            <label>
              <input
                type="radio"
                name="collaboration-project-location"
                value="local"
                data-testid="collaboration-project-location-local"
                checked={projectStore === 'local'}
                onChange={() => setProjectStore('local')}
              />
              {messages.localProject}
            </label>
          </fieldset>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            {messages.cancel}
          </button>
          <button
            type="submit"
            className="collaboration-primary-button"
            data-testid={collaborationTestIds.createProjectConfirm}
            disabled={!name.trim()}
          >
            {messages.create}
          </button>
        </footer>
      </form>
    </DialogFrame>
  )
}

function CreateIssueDialog({
  statuses,
  messages,
  onClose,
  onCreate,
}: {
  statuses: CollaborationStatus[]
  messages: Messages
  onClose(): void
  onCreate(values: {
    title: string
    description: string
    status: string
    priority: CollaborationPriority
  }): Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState(statuses[0]?.id ?? 'pending')
  const [priority, setPriority] = useState<CollaborationPriority>('none')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (title.trim()) {
      void onCreate({
        title: title.trim(),
        description: description.trim(),
        status,
        priority,
      })
    }
  }
  return (
    <DialogFrame testId={collaborationTestIds.createIssueDialog} title={messages.createIssue}>
      <form onSubmit={submit}>
        <label>
          {messages.issueTitle}
          <input
            data-testid="collaboration-issue-title-input"
            value={title}
            onChange={event => setTitle(event.target.value)}
            autoFocus
          />
        </label>
        <label>
          {messages.issueDescription}
          <textarea
            data-testid="collaboration-issue-description-input"
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </label>
        <div className="collaboration-form-row">
          <label>
            {messages.issueStatus}
            <select
              data-testid="collaboration-issue-status-input"
              value={status}
              onChange={event => setStatus(event.target.value)}
            >
              {statuses.map(item => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {messages.issuePriority}
            <select
              data-testid="collaboration-issue-priority-input"
              value={priority}
              onChange={event => setPriority(event.target.value as CollaborationPriority)}
            >
              {['none', 'low', 'medium', 'high', 'urgent'].map(value => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
        <footer>
          <button type="button" onClick={onClose}>
            {messages.cancel}
          </button>
          <button
            type="submit"
            className="collaboration-primary-button"
            data-testid={collaborationTestIds.createIssueConfirm}
            disabled={!title.trim()}
          >
            {messages.create}
          </button>
        </footer>
      </form>
    </DialogFrame>
  )
}

function CapabilityView({
  title,
  unavailable,
  unavailableMessage,
}: {
  title: string
  unavailable: boolean
  unavailableMessage: string
}) {
  return (
    <section className="collaboration-panel">
      <h2>{title}</h2>
      {unavailable && <p>{unavailableMessage}</p>}
    </section>
  )
}
