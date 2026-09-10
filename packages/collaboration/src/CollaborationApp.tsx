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
import { WorkspaceProjectsHomeAdapter } from './web-adapter/WorkspaceProjectsHomeAdapter'
import {
  ProjectViewSwitcher,
  type CollaborationProjectViewOption,
} from './workspace-header/ProjectViewSwitcher'
import type {
  CollaborationAttachment,
  CollaborationComment,
  CollaborationExecution,
  CollaborationHostAdapter,
  CollaborationIssue,
  CollaborationMember,
  CollaborationPriority,
  CollaborationProject,
  CollaborationStatus,
  CollaborationUser,
  CollaborationView,
} from './types'
import type { SharedWorkspaceApi } from './ports/SharedWorkspaceApi'

const DEFAULT_STATUSES: CollaborationStatus[] = [
  { id: 'pending', name: '待处理', color: 'gray' },
  { id: 'in_progress', name: '进行中', color: 'blue' },
  { id: 'completed', name: '已完成', color: 'green' },
]

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
  const [projectItems, setProjectItems] = useState<Record<string, CollaborationIssue[]>>({})
  const [projectMembers, setProjectMembers] = useState<Record<string, CollaborationMember[]>>({})
  const [project, setProject] = useState<CollaborationProject | null>(null)
  const [issues, setIssues] = useState<CollaborationIssue[]>([])
  const [members, setMembers] = useState<CollaborationMember[]>([])
  const [runs, setRuns] = useState<CollaborationExecution[]>([])
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
        setMembers(snapshot.members)
        setError(null)
      } catch {
        setError(messages.loadFailed)
      } finally {
        if (showLoading) setLoading(false)
      }
    },
    [api, messages.loadFailed]
  )

  useEffect(() => {
    if (host.location.projectId) {
      void loadProject(host.location.projectId)
    } else {
      setProject(null)
      setSelectedIssue(null)
      void loadProjects()
    }
  }, [host.location.projectId, loadProject, loadProjects])

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

  useEffect(() => {
    if (!project) return
    if (host.location.view === 'members') {
      void api.members
        .list(project.id)
        .then(setMembers)
        .catch(() => setError(messages.loadFailed))
    }
    if (host.location.view === 'runs') {
      void api.executions
        .list(project.id)
        .then(setRuns)
        .catch(() => setError(messages.loadFailed))
    }
  }, [api, host.location.view, messages.loadFailed, project])

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
      {!project ? (
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
              options={
                [
                  {
                    id: 'board',
                    label: messages.board,
                    testId: 'collaboration-tab-board',
                  },
                  {
                    id: 'files',
                    label: messages.files,
                    testId: 'collaboration-tab-files',
                  },
                  {
                    id: 'members',
                    label: messages.members,
                    testId: 'collaboration-tab-members',
                  },
                  ...(host.capabilities.automation
                    ? [
                        {
                          id: 'automation' as const,
                          label: messages.automation,
                          testId: 'collaboration-tab-automation',
                        },
                        {
                          id: 'runs' as const,
                          label: messages.runs,
                          testId: 'collaboration-tab-runs',
                        },
                      ]
                    : []),
                  {
                    id: 'manage',
                    label: messages.settings,
                    testId: 'collaboration-tab-manage',
                  },
                ] satisfies CollaborationProjectViewOption[]
              }
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
          {host.location.view === 'members' && (
            <MembersView
              api={api.members}
              project={project}
              members={members}
              messages={messages}
              onChange={setMembers}
              onError={() => notify(messages.saveFailed)}
            />
          )}
          {host.location.view === 'runs' && (
            <RunsView
              api={api.executions}
              project={project}
              runs={runs}
              messages={messages}
              onChange={setRuns}
              onError={() => notify(messages.saveFailed)}
            />
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
              api={api.projects}
              project={project}
              labels={{
                settings: messages.settings,
                projectName: messages.projectName,
                projectDescription: messages.projectDescription,
                visibility: messages.visibility,
                privateVisibility: messages.privateVisibility,
                publicVisibility: messages.publicVisibility,
                tags: messages.tags,
                tagsHint: messages.tagsHint,
                boardLayout: messages.boardLayout,
                boardLayoutHint: messages.boardLayoutHint,
                statusName: messages.statusName,
                statusColor: messages.statusColor,
                processingStatus: messages.processingStatus,
                addStatus: messages.addStatus,
                remove: messages.remove,
                moveUp: messages.moveUp,
                moveDown: messages.moveDown,
                cardDisplay: messages.cardDisplay,
                showAssignee: messages.showAssignee,
                showPriority: messages.showPriority,
                showTags: messages.showTags,
                showDate: messages.showDate,
                repository: messages.repository,
                providerToken: messages.providerToken,
                providerTokenHint: messages.providerTokenHint,
                aitableUrl: messages.aitableUrl,
                save: messages.save,
                archiveProject: messages.archiveProject,
                archiveConfirm: messages.archiveConfirm,
              }}
              onChange={setProject}
              onArchived={() => host.navigate({ projectId: null, issueId: null, view: 'board' })}
              onConflict={async () => {
                await loadProject(project.id, false)
                notify(messages.conflict)
              }}
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

function MembersView({
  api,
  project,
  members,
  messages,
  onChange,
  onError,
}: {
  api: SharedWorkspaceApi['members']
  project: CollaborationProject
  members: CollaborationMember[]
  messages: Messages
  onChange(members: CollaborationMember[]): void
  onError(): void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CollaborationUser[]>([])
  const [searching, setSearching] = useState(false)
  const canManage = project.access_role === 'Owner' || project.access_role === 'Maintainer'
  const search = async (event: FormEvent) => {
    event.preventDefault()
    if (!query.trim()) return
    setSearching(true)
    try {
      const memberIds = new Set(members.map(member => member.user_id))
      setResults((await api.searchUsers(query.trim())).filter(user => !memberIds.has(user.id)))
    } catch {
      onError()
    } finally {
      setSearching(false)
    }
  }
  return (
    <section className="collaboration-panel" data-testid={collaborationTestIds.members}>
      <header>
        <h2>{messages.members}</h2>
        {canManage && (
          <form className="collaboration-member-search" onSubmit={search}>
            <input
              data-testid="collaboration-member-search"
              value={query}
              placeholder={messages.searchMembers}
              onChange={event => setQuery(event.target.value)}
            />
            <button type="submit" disabled={!query.trim() || searching}>
              {messages.search}
            </button>
          </form>
        )}
      </header>
      {results.length > 0 && (
        <ul className="collaboration-member-results">
          {results.map(user => (
            <li key={user.id}>
              <span>
                <strong>{user.user_name}</strong>
                <small>{user.email}</small>
              </span>
              <button
                type="button"
                data-testid={`collaboration-member-add-${user.id}`}
                onClick={async () => {
                  try {
                    const added = await api.add(project.id, user.id)
                    onChange([...members, added])
                    setResults(current => current.filter(item => item.id !== user.id))
                  } catch {
                    onError()
                  }
                }}
              >
                {messages.add}
              </button>
            </li>
          ))}
        </ul>
      )}
      {members.length === 0 ? (
        <p>{messages.emptyMembers}</p>
      ) : (
        <ul className="collaboration-member-list">
          {members.map(member => (
            <li key={member.id}>
              <span>
                <strong>{member.user_name}</strong>
                <small>{member.email}</small>
              </span>
              {canManage && member.role !== 'Owner' ? (
                <span className="collaboration-member-actions">
                  <select
                    aria-label={`${messages.role}: ${member.user_name}`}
                    value={member.role}
                    onChange={async event => {
                      try {
                        const updated = await api.update(project.id, member.user_id, {
                          role: event.target.value as Exclude<CollaborationMember['role'], 'Owner'>,
                        })
                        onChange(
                          members.map(item => (item.user_id === updated.user_id ? updated : item))
                        )
                      } catch {
                        onError()
                      }
                    }}
                  >
                    <option value="Maintainer">Maintainer</option>
                    <option value="Developer">Developer</option>
                    <option value="Reporter">Reporter</option>
                  </select>
                  <button
                    type="button"
                    aria-label={`${messages.remove}: ${member.user_name}`}
                    data-testid={`collaboration-member-remove-${member.user_id}`}
                    onClick={async () => {
                      try {
                        await api.remove(project.id, member.user_id)
                        onChange(members.filter(item => item.user_id !== member.user_id))
                      } catch {
                        onError()
                      }
                    }}
                  >
                    {messages.remove}
                  </button>
                </span>
              ) : (
                <span>{member.role}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function RunsView({
  api,
  project,
  runs,
  messages,
  onChange,
  onError,
}: {
  api: SharedWorkspaceApi['executions']
  project: CollaborationProject
  runs: CollaborationExecution[]
  messages: Messages
  onChange(runs: CollaborationExecution[]): void
  onError(): void
}) {
  return (
    <section className="collaboration-panel" data-testid={collaborationTestIds.runs}>
      <h2>{messages.runs}</h2>
      {runs.length === 0 ? (
        <p>{messages.emptyRuns}</p>
      ) : (
        <ul className="collaboration-run-list">
          {runs.map(run => (
            <li key={run.id}>
              <span>
                <strong>{run.task_title}</strong>
                <small>{run.display_state || run.status}</small>
              </span>
              {['queued', 'running', 'starting'].includes(run.status) && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await api.stop(project.id, run.id)
                      onChange(
                        runs.map(item =>
                          item.id === run.id ? { ...item, status: 'cancelling' } : item
                        )
                      )
                    } catch {
                      onError()
                    }
                  }}
                >
                  {messages.stop}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
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
