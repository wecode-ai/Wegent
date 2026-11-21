import { DialogSurface } from '../controls/DialogSurface'
import { Textarea as ControlTextarea } from '../controls/Textarea'
import { TextField as ControlInput } from '../controls/TextField'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { CollaborationPlatformHostAdapter } from './types'
import { useState } from 'react'
import {
  Cloud,
  X,
  Activity,
  AlertTriangle,
  Bot,
  CircleCheck,
  ChevronRight,
  Clock3,
  FolderPlus,
  SquarePen,
  UserRound,
  UsersRound,
} from 'lucide-react'
import { type PlatformMessages } from './platformMessages'
import { ProjectCreationAction } from './ProjectCreationAction'
import { type CollaborationLocale } from '../i18n'
import type { WorkspaceMyWorkItem } from '../ports/SharedWorkspaceApi'
import type { CollaborationIssue, CollaborationProject, CollaborationWorkspace } from '../types'
import {
  createWorkspaceOperationsSnapshot,
  workspaceIssueOperationState,
  type WorkspaceOperationState,
  type WorkspaceProjectIssuesSnapshot,
} from './workspaceOperations'

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle: string
  action?: React.ReactNode
}) {
  return (
    <header className="collaboration-platform-page-header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </header>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="collaboration-platform-empty">
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  )
}

export function ProjectCards({
  projects,
  messages,
  onOpen,
}: {
  projects: CollaborationProject[]
  messages: PlatformMessages
  onOpen(project: CollaborationProject): void
}) {
  if (!projects.length) {
    return <EmptyState title={messages.noProjects} description={messages.noProjectsHint} />
  }
  return (
    <div className="collaboration-project-card-grid">
      {projects.map(project => (
        <ControlButton
          variant="unstyled"
          type="button"
          className="collaboration-project-card"
          data-testid={`collaboration-project-card-${project.id}`}
          key={project.id}
          onClick={() => onOpen(project)}
        >
          <span className="collaboration-project-card-mark">{project.project_key.slice(0, 2)}</span>
          <span>
            <strong>{project.name}</strong>
            <small>{project.description || project.project_key}</small>
          </span>
          <em>{messages.enterProject} →</em>
        </ControlButton>
      ))}
    </div>
  )
}

export function WorkspaceHome({
  projects,
  projectIssues,
  locale,
  messages,
  onOpenProject,
  onOpenProjects,
  onOpenIssue,
}: {
  projects: CollaborationProject[]
  projectIssues: Record<string, WorkspaceProjectIssuesSnapshot>
  locale: CollaborationLocale
  messages: PlatformMessages
  onOpenProject(project: CollaborationProject): void
  onOpenProjects(): void
  onOpenIssue(project: CollaborationProject, issue: CollaborationIssue): void
}) {
  const snapshot = createWorkspaceOperationsSnapshot({
    projects,
    projectIssues,
  })
  const metrics = [
    {
      id: 'running',
      label: messages.running,
      value: snapshot.totals.running,
      icon: Activity,
      tone: 'running',
    },
    {
      id: 'review',
      label: messages.waitingReview,
      value: snapshot.totals.review,
      icon: Clock3,
      tone: 'review',
    },
    {
      id: 'failed',
      label: messages.failed,
      value: snapshot.totals.failed,
      icon: AlertTriangle,
      tone: 'failed',
    },
    {
      id: 'pending',
      label: messages.pending,
      value: snapshot.totals.pending,
      icon: CircleCheck,
      tone: 'pending',
    },
  ]

  return (
    <div data-testid="collaboration-workspace-home">
      <section
        className="collaboration-workspace-operation-metrics"
        aria-label={messages.operationsOverview}
      >
        {metrics.map(metric => {
          const Icon = metric.icon
          return (
            <div
              data-testid={`collaboration-workspace-metric-${metric.id}`}
              data-tone={metric.tone}
              key={metric.id}
            >
              <span>
                <Icon aria-hidden="true" />
              </span>
              <strong>{metric.value}</strong>
              <small>{metric.label}</small>
            </div>
          )
        })}
      </section>

      <div className="collaboration-workspace-operations-layout">
        <section className="collaboration-workspace-operations-projects">
          <div className="collaboration-workspace-operations-heading">
            <div>
              <h2>{messages.operatingProjects}</h2>
              <p>{messages.operatingProjectsHint}</p>
            </div>
            <ControlButton variant="unstyled" type="button" onClick={onOpenProjects}>
              {messages.viewAll}
              <ChevronRight aria-hidden="true" />
            </ControlButton>
          </div>
          <div className="collaboration-workspace-operation-table">
            {snapshot.operations.map(operation => {
              const projectState: WorkspaceOperationState | 'idle' = operation.unavailable
                ? 'unavailable'
                : operation.failedCount > 0
                  ? 'failed'
                  : operation.reviewCount > 0
                    ? 'review'
                    : operation.runningCount > 0
                      ? 'running'
                      : 'idle'
              return (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={`collaboration-workspace-operation-project-${operation.project.id}`}
                  key={operation.project.id}
                  onClick={() => onOpenProject(operation.project)}
                >
                  <span className="collaboration-project-card-mark">
                    {operation.project.project_key.slice(0, 2)}
                  </span>
                  <span className="collaboration-workspace-operation-project-copy">
                    <strong>{operation.project.name}</strong>
                    <small>
                      {operation.unavailable
                        ? messages.unavailable
                        : `${operation.issues.length} ${messages.issues}`}
                    </small>
                  </span>
                  <OperationStateBadge messages={messages} state={projectState} />
                  {operation.unavailable ? (
                    <span className="collaboration-workspace-operation-counts">
                      <span data-tone="failed">{messages.unavailable}</span>
                    </span>
                  ) : (
                    <span className="collaboration-workspace-operation-counts">
                      <span data-tone="running">
                        {operation.runningCount} {messages.running}
                      </span>
                      <span data-tone="review">
                        {operation.reviewCount} {messages.waitingReview}
                      </span>
                      {operation.failedCount > 0 ? (
                        <span data-tone="failed">
                          {operation.failedCount} {messages.failed}
                        </span>
                      ) : null}
                    </span>
                  )}
                  <time dateTime={operation.updatedAt}>
                    {formatOperationTime(locale, operation.updatedAt)}
                  </time>
                  <ChevronRight aria-hidden="true" />
                </ControlButton>
              )
            })}
          </div>
        </section>

        <section className="collaboration-workspace-attention">
          <div className="collaboration-workspace-operations-heading">
            <div>
              <h2>{messages.needsAttention}</h2>
              <p>
                {snapshot.totals.failed + snapshot.totals.review + snapshot.totals.unavailable}{' '}
                {messages.attentionCount}
              </p>
            </div>
          </div>
          {snapshot.unavailableProjects.length > 0 || snapshot.attentionItems.length > 0 ? (
            <div className="collaboration-workspace-attention-list">
              {snapshot.unavailableProjects.map(operation => (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={`collaboration-workspace-unavailable-${operation.project.id}`}
                  key={`unavailable:${operation.project.id}`}
                  onClick={() => onOpenProject(operation.project)}
                >
                  <OperationStateBadge messages={messages} state="unavailable" />
                  <strong>{operation.project.name}</strong>
                  <span>{messages.unavailable}</span>
                  <time dateTime={operation.updatedAt}>
                    {formatOperationTime(locale, operation.updatedAt)}
                  </time>
                </ControlButton>
              ))}
              {snapshot.attentionItems.map(({ issue, project }) => {
                const state = workspaceIssueOperationState(issue)
                return (
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid={`collaboration-workspace-attention-${issue.id}`}
                    key={issue.id}
                    onClick={() => onOpenIssue(project, issue)}
                  >
                    <OperationStateBadge messages={messages} state={state} />
                    <strong>{issue.title}</strong>
                    <span>{project.name}</span>
                    <time dateTime={issue.updated_at}>
                      {formatOperationTime(locale, issue.updated_at)}
                    </time>
                  </ControlButton>
                )
              })}
            </div>
          ) : (
            <div className="collaboration-workspace-attention-empty">
              <CircleCheck aria-hidden="true" />
              <strong>{messages.stable}</strong>
              <span>{messages.noAttention}</span>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function OperationStateBadge({
  state,
  messages,
}: {
  state: WorkspaceOperationState | 'idle'
  messages: PlatformMessages
}) {
  const label =
    state === 'failed'
      ? messages.failed
      : state === 'unavailable'
        ? messages.unavailable
        : state === 'review'
          ? messages.waitingReview
          : state === 'running'
            ? messages.running
            : state === 'pending'
              ? messages.pending
              : state === 'completed'
                ? messages.stable
                : messages.idle
  return (
    <span className="collaboration-workspace-operation-state" data-tone={state}>
      <i aria-hidden="true" />
      {label}
    </span>
  )
}

function formatOperationTime(locale: CollaborationLocale, value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function workItemOwner(item: WorkspaceMyWorkItem, messages: PlatformMessages) {
  if (item.assignee_group_id) {
    return {
      name: item.assignee_group_name || messages.group,
      kind: messages.group,
      icon: UsersRound,
    }
  }
  if (item.assignee_team_id != null) {
    return {
      name: item.assignee_team_name || messages.group,
      kind: messages.group,
      icon: UsersRound,
    }
  }
  if (item.assignee_agent_id) {
    return {
      name: item.assignee_agent_name || messages.agent,
      kind: messages.agent,
      icon: Bot,
    }
  }
  if (item.assignee_user_id != null) {
    return {
      name: item.assignee_name || messages.human,
      kind: messages.human,
      icon: UserRound,
    }
  }
  return {
    name: messages.unassigned,
    kind: '',
    icon: UserRound,
  }
}

function workItemStep(item: WorkspaceMyWorkItem, messages: PlatformMessages): string {
  if (item.status === 'in_review') return messages.waitingReview
  if (item.execution_state) return item.execution_state.replace(/_/g, ' ')
  return item.status.replace(/_/g, ' ')
}

function workItemStatus(item: WorkspaceMyWorkItem, messages: PlatformMessages) {
  const state = workspaceIssueOperationState(item)
  return {
    state,
    label:
      state === 'failed'
        ? messages.failed
        : state === 'review'
          ? messages.waitingReview
          : state === 'running'
            ? messages.running
            : state === 'completed'
              ? messages.stable
              : messages.pending,
  }
}

function WorkItemRow({
  item,
  locale,
  messages,
  onOpen,
}: {
  item: WorkspaceMyWorkItem
  locale: CollaborationLocale
  messages: PlatformMessages
  onOpen(item: WorkspaceMyWorkItem): void
}) {
  const owner = workItemOwner(item, messages)
  const status = workItemStatus(item, messages)
  const OwnerIcon = owner.icon
  return (
    <ControlButton
      variant="unstyled"
      type="button"
      className="collaboration-home-work-row"
      data-testid={`collaboration-home-work-${item.id}`}
      onClick={() => onOpen(item)}
    >
      <span className="collaboration-home-work-issue">
        <strong>
          #{item.sequence_number} {item.title}
        </strong>
        <small>
          {item.project_key} · {item.project_name}
        </small>
      </span>
      <span className="collaboration-home-work-owner">
        <i>
          <OwnerIcon aria-hidden="true" />
        </i>
        <span>
          <strong>{owner.name}</strong>
          <small>{owner.kind}</small>
        </span>
      </span>
      <span className="collaboration-home-work-step">
        <strong>{workItemStep(item, messages)}</strong>
        <small>{item.status}</small>
      </span>
      <OperationStateBadge messages={messages} state={status.state} />
      <time dateTime={item.updated_at}>{formatOperationTime(locale, item.updated_at)}</time>
      <ChevronRight aria-hidden="true" />
    </ControlButton>
  )
}

export function FirstWorkStarter({
  messages,
  supportsLocalImport,
  onCreate,
  onCreateIssue,
}: {
  messages: PlatformMessages
  supportsLocalImport: boolean
  onCreate(mode: 'blank' | 'folder' | 'existing'): void
  onCreateIssue?(): void
}) {
  const title = onCreateIssue ? messages.firstIssueHomeTitle : messages.firstProjectHomeTitle
  return (
    <section
      className={`collaboration-first-project-starter${onCreateIssue ? ' collaboration-first-issue-starter' : ''}`}
      data-testid={
        onCreateIssue ? 'collaboration-first-issue-starter' : 'collaboration-first-project-starter'
      }
    >
      <span className="collaboration-first-project-icon">
        {onCreateIssue ? <SquarePen aria-hidden="true" /> : <FolderPlus aria-hidden="true" />}
      </span>
      <div className="collaboration-first-project-copy">
        <h2>{title}</h2>
        <p>{onCreateIssue ? messages.firstIssueHomeHint : messages.firstProjectHomeHint}</p>
      </div>
      <div className="collaboration-first-project-guide" aria-label={title}>
        <span>
          <SquarePen aria-hidden="true" />
          {messages.firstProjectGuideCapture}
        </span>
        <ChevronRight aria-hidden="true" />
        <span>
          <UsersRound aria-hidden="true" />
          {messages.firstProjectGuideAssign}
        </span>
        <ChevronRight aria-hidden="true" />
        <span>
          <CircleCheck aria-hidden="true" />
          {messages.firstProjectGuideTrack}
        </span>
      </div>
      {onCreateIssue ? (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="collaboration-first-issue-create"
          className="collaboration-primary-button collaboration-first-project-create"
          onClick={onCreateIssue}
        >
          <SquarePen aria-hidden="true" />
          {messages.createIndependentIssue}
        </ControlButton>
      ) : (
        <ProjectCreationAction
          className="collaboration-primary-button collaboration-first-project-create"
          messages={messages}
          onSelect={onCreate}
          supportsLocalImport={supportsLocalImport}
          testId="collaboration-first-project-create"
        />
      )}
    </section>
  )
}

export function WorkItemsPage({
  title,
  subtitle,
  empty,
  items,
  locale,
  messages,
  onOpenItem,
}: {
  title: string
  subtitle: string
  empty: string
  items: WorkspaceMyWorkItem[]
  locale: CollaborationLocale
  messages: PlatformMessages
  onOpenItem(item: WorkspaceMyWorkItem): void
}) {
  return (
    <div className="collaboration-platform-page">
      <PageHeader title={title} subtitle={subtitle} />
      {items.length ? (
        <div className="collaboration-home-work-groups">
          <section data-testid="collaboration-work-group-assigned">
            <h2 className="collaboration-home-work-group-title">
              {locale === 'zh-CN' ? '待我处理' : 'Assigned to me'}
            </h2>
            <div className="collaboration-home-work-list">
              {items.map(item => (
                <WorkItemRow
                  item={item}
                  locale={locale}
                  messages={messages}
                  key={item.id}
                  onOpen={onOpenItem}
                />
              ))}
            </div>
          </section>
        </div>
      ) : (
        <EmptyState title={empty} description={messages.workspaceHint} />
      )}
    </div>
  )
}

export function WorkspaceSettings({
  workspace,
  displayName,
  messages,
  onSave,
}: {
  workspace: CollaborationWorkspace
  displayName?: string
  messages: PlatformMessages
  onSave(input: { version: number; name: string; description: string }): Promise<void>
}) {
  const [name, setName] = useState(displayName ?? workspace.name)
  const [description, setDescription] = useState(workspace.description)
  const [saving, setSaving] = useState(false)
  return (
    <section className="collaboration-platform-panel collaboration-workspace-settings">
      <h2>{messages.settings}</h2>
      <p>{messages.workspaceSettingsHint}</p>
      <label>
        {messages.name}
        <ControlInput value={name} onChange={event => setName(event.target.value)} />
      </label>
      <label>
        {messages.description}
        <ControlTextarea
          value={description}
          onChange={event => setDescription(event.target.value)}
        />
      </label>
      <ControlButton
        variant="unstyled"
        type="button"
        className="collaboration-primary-button"
        data-testid="collaboration-workspace-settings-save"
        disabled={saving || !name.trim()}
        onClick={() => {
          setSaving(true)
          void onSave({
            version: workspace.version,
            name: displayName && name.trim() === displayName ? workspace.name : name.trim(),
            description: description.trim(),
          }).finally(() => setSaving(false))
        }}
      >
        {messages.save}
      </ControlButton>
    </section>
  )
}
export function WorkspaceProjectPicker({
  messages,
  workspaces,
  cloudAccess,
  canCreateCloudWorkspace,
  onClose,
  onCreateCloudWorkspace,
  onSelect,
}: {
  messages: PlatformMessages
  workspaces: CollaborationWorkspace[]
  cloudAccess: CollaborationPlatformHostAdapter['cloudAccess']
  canCreateCloudWorkspace: boolean
  onClose(): void
  onCreateCloudWorkspace(): void
  onSelect(workspaceId: string): void
}) {
  const hasCloudWorkspace = workspaces.some(workspace => workspace.location === 'cloud')
  const showCloudEntry = canCreateCloudWorkspace && !hasCloudWorkspace
  const cloudLoginRequired = cloudAccess && !cloudAccess.authenticated
  return (
    <div className="collaboration-dialog-backdrop">
      <DialogSurface
        onClose={onClose}
        render={
          <section
            className="collaboration-dialog collaboration-workspace-picker"
            aria-label={messages.chooseProjectWorkspace}
          />
        }
      >
        <header>
          <div>
            <h2>{messages.chooseProjectWorkspace}</h2>
            <p>{messages.chooseProjectWorkspaceHint}</p>
          </div>
          <ControlButton
            variant="unstyled"
            type="button"
            onClick={onClose}
            aria-label={messages.cancel}
          >
            <X aria-hidden="true" />
          </ControlButton>
        </header>
        <div>
          {workspaces.map(workspace => (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid={`collaboration-project-workspace-${workspace.id}`}
              key={workspace.id}
              onClick={() => onSelect(workspace.id)}
            >
              <span className="collaboration-project-card-mark">{workspace.name.slice(0, 2)}</span>
              <span>
                <strong>{workspace.name}</strong>
                <small>
                  {workspace.project_count} {messages.projectCount}
                </small>
              </span>
              <ChevronRight aria-hidden="true" />
            </ControlButton>
          ))}
          {showCloudEntry ? (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid={
                cloudLoginRequired
                  ? 'collaboration-project-workspace-cloud-login'
                  : 'collaboration-project-workspace-cloud-create'
              }
              onClick={cloudLoginRequired ? cloudAccess.requestLogin : onCreateCloudWorkspace}
            >
              <span className="collaboration-project-card-mark">
                <Cloud aria-hidden="true" />
              </span>
              <span>
                <strong>
                  {cloudLoginRequired ? messages.loginForCloudProject : messages.createWorkspace}
                </strong>
                <small>
                  {cloudLoginRequired
                    ? messages.loginForCloudProjectHint
                    : messages.cloudStorageNotice}
                </small>
              </span>
              <ChevronRight aria-hidden="true" />
            </ControlButton>
          ) : null}
        </div>
      </DialogSurface>
    </div>
  )
}
