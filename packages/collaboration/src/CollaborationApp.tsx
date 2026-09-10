// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react'

import type { CollaborationApi } from './api'
import { CollaborationBoard } from './CollaborationBoard'
import { collaborationMessages, type CollaborationLocale } from './i18n'
import { collaborationTestIds } from './testIds'
import { CollaborationProjectSummary } from './CollaborationProjectSummary'
import { IssueDetail } from './IssueDetail'
import type {
  CollaborationAttachment,
  CollaborationComment,
  CollaborationExecution,
  CollaborationFile,
  CollaborationHostAdapter,
  CollaborationIssue,
  CollaborationMember,
  CollaborationPriority,
  CollaborationProject,
  CollaborationStatus,
  CollaborationUser,
  CollaborationView,
} from './types'

const DEFAULT_STATUSES: CollaborationStatus[] = [
  { id: 'pending', name: '待处理', color: 'gray' },
  { id: 'in_progress', name: '进行中', color: 'blue' },
  { id: 'completed', name: '已完成', color: 'green' },
]

interface CollaborationAppProps {
  api: CollaborationApi
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

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export function CollaborationApp({
  api,
  host,
  locale = 'zh-CN',
  pollIntervalMs = 15_000,
}: CollaborationAppProps) {
  const messages = collaborationMessages[locale]
  const [projects, setProjects] = useState<CollaborationProject[]>([])
  const [project, setProject] = useState<CollaborationProject | null>(null)
  const [issues, setIssues] = useState<CollaborationIssue[]>([])
  const [members, setMembers] = useState<CollaborationMember[]>([])
  const [files, setFiles] = useState<CollaborationFile[]>([])
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
      setProjects(await api.listProjects())
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
          api.getProject(projectId),
          api.getBoardSnapshot(projectId),
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
      api.getIssue(issueId),
      api.listAttachments(issueId),
      api.listComments(issueId),
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
    if (host.location.view === 'files') {
      void api
        .listFiles(project.id)
        .then(setFiles)
        .catch(() => setError(messages.loadFailed))
    }
    if (host.location.view === 'members') {
      void api
        .listMembers(project.id)
        .then(setMembers)
        .catch(() => setError(messages.loadFailed))
    }
    if (host.location.view === 'runs') {
      void api
        .listExecutions(project.id)
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
        <ProjectHome
          projects={projects}
          messages={messages}
          onCreate={() => setCreateProjectOpen(true)}
          onOpen={nextProject =>
            host.navigate({
              projectId: nextProject.id,
              issueId: null,
              view: 'board',
            })
          }
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
          <nav className="collaboration-tabs" aria-label={messages.title}>
            {(
              [
                ['board', messages.board],
                ['files', messages.files],
                ['members', messages.members],
                ...(host.capabilities.automation
                  ? ([
                      ['automation', messages.automation],
                      ['runs', messages.runs],
                    ] as const)
                  : []),
                ['manage', messages.settings],
              ] as Array<[CollaborationView, string]>
            ).map(([view, label]) => (
              <button
                type="button"
                key={view}
                data-testid={`collaboration-tab-${view}`}
                aria-current={host.location.view === view ? 'page' : undefined}
                onClick={() => navigateView(view)}
              >
                {label}
              </button>
            ))}
          </nav>
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
                  const updated = await api.reorderIssues(project.id, {
                    parent_id: issue.parent_id,
                    status,
                    item_ids: laneIds,
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
                    await api.updateProject(project.id, {
                      version: project.version,
                      board_config: { ...currentConfig, group_by: groupBy },
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
            <FilesView
              api={api}
              project={project}
              files={files}
              messages={messages}
              onChange={setFiles}
              onError={() => notify(messages.saveFailed)}
            />
          )}
          {host.location.view === 'members' && (
            <MembersView
              api={api}
              project={project}
              members={members}
              messages={messages}
              onChange={setMembers}
              onError={() => notify(messages.saveFailed)}
            />
          )}
          {host.location.view === 'runs' && (
            <RunsView
              api={api}
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
            <ProjectSettings
              api={api}
              project={project}
              messages={messages}
              onChange={setProject}
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
              const created = await api.createProject(values)
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
              const created = await api.createIssue(project.id, values)
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
            const current = await api.getIssue(selectedIssue.id)
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

function ProjectHome({
  projects,
  messages,
  onCreate,
  onOpen,
}: {
  projects: CollaborationProject[]
  messages: Messages
  onCreate(): void
  onOpen(project: CollaborationProject): void
}) {
  return (
    <>
      <header className="collaboration-home-header">
        <div>
          <h1>{messages.title}</h1>
          <p>{messages.subtitle}</p>
        </div>
        <button
          type="button"
          className="collaboration-primary-button"
          data-testid={collaborationTestIds.createProject}
          onClick={onCreate}
        >
          {messages.createProject}
        </button>
      </header>
      {projects.length === 0 ? (
        <div className="collaboration-empty">
          <strong>{messages.emptyProjects}</strong>
          <p>{messages.emptyProjectsHint}</p>
        </div>
      ) : (
        <div className="collaboration-project-grid" data-testid={collaborationTestIds.projectList}>
          {projects.map(project => (
            <button
              type="button"
              className="collaboration-project-card"
              data-testid={collaborationTestIds.project(project.id)}
              key={project.id}
              onClick={() => onOpen(project)}
            >
              <CollaborationProjectSummary
                project={project}
                description={project.description || project.project_key}
              />
              <small>
                {project.project_store === 'local' ? messages.localProject : messages.cloudProject}
                {project.access_role ? ` · ${project.access_role}` : ''}
              </small>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

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

function FilesView({
  api,
  project,
  files,
  messages,
  onChange,
  onError,
}: {
  api: CollaborationApi
  project: CollaborationProject
  files: CollaborationFile[]
  messages: Messages
  onChange(files: CollaborationFile[]): void
  onError(): void
}) {
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      onChange([...files, await api.uploadFile(project.id, file)])
      event.target.value = ''
    } catch {
      onError()
    }
  }
  return (
    <section className="collaboration-panel" data-testid={collaborationTestIds.files}>
      <header>
        <h2>{messages.files}</h2>
        <label className="collaboration-file-button">
          {messages.uploadFile}
          <input type="file" data-testid="collaboration-file-upload" onChange={upload} />
        </label>
      </header>
      {files.length === 0 ? (
        <p>{messages.emptyFiles}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{messages.fileName}</th>
              <th>{messages.fileSize}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {files.map(file => (
              <tr key={file.id}>
                <td>{file.path}</td>
                <td>{file.kind === 'folder' ? '—' : formatBytes(file.size_bytes)}</td>
                <td>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await api.deleteFile(file.id, file.kind === 'folder')
                        onChange(files.filter(item => item.id !== file.id))
                      } catch {
                        onError()
                      }
                    }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
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
  api: CollaborationApi
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
                    const added = await api.addMember(project.id, user.id)
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
                        const updated = await api.updateMember(project.id, member.user_id, {
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
                        await api.removeMember(project.id, member.user_id)
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
  api: CollaborationApi
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
                      await api.stopExecution(project.id, run.id)
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

function ProjectSettings({
  api,
  project,
  messages,
  onChange,
  onConflict,
  onError,
}: {
  api: CollaborationApi
  project: CollaborationProject
  messages: Messages
  onChange(project: CollaborationProject): void
  onConflict(): Promise<void>
  onError(): void
}) {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  useEffect(() => {
    setName(project.name)
    setDescription(project.description)
  }, [project])
  return (
    <section className="collaboration-panel collaboration-settings">
      <h2>{messages.settings}</h2>
      <label>
        {messages.projectName}
        <input value={name} onChange={event => setName(event.target.value)} />
      </label>
      <label>
        {messages.projectDescription}
        <textarea value={description} onChange={event => setDescription(event.target.value)} />
      </label>
      <button
        type="button"
        className="collaboration-primary-button"
        onClick={async () => {
          try {
            onChange(
              await api.updateProject(project.id, {
                version: project.version,
                name: name.trim(),
                description: description.trim(),
              })
            )
          } catch (error) {
            if (errorStatus(error) === 409) await onConflict()
            else onError()
          }
        }}
      >
        {messages.save}
      </button>
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
