import type {
  CollaborationProject,
  SharedWorkspaceApi,
  CollaborationIssue,
} from '@wegent/collaboration'
import type { ProjectChatClient } from '@/api/backend/projectChatSocket'
import type { HttpClient } from '@/api/http'
import type { LocalProjectMigrationSnapshot } from '@/features/workbench/workbenchServices'

export interface LocalProjectImport {
  source: string
  local_user_id: number
  source_project_id: string
  milestones: Array<{
    id: string
    title: string
    description: string
    state: 'open' | 'closed'
    due_on: string | null
  }>
  name: string
  description: string
  settings: Record<string, unknown>
  issues: Array<{
    id: string
    parent_id: string | null
    version: number
    milestone_id: string | null
    security_level: 'open' | 'related'
    assignee_user_id: number | null
    title: string
    description: string
    status: string
    priority: string
    sequence_number: number
    sort_order: number
    tags: string[]
    due_at: string | null
    start_at: string | null
    archived_at: string | null
    created_at: string
    updated_at: string
  }>
  comments: Array<{
    id: string
    issue_id: string
    author: string
    body: string
    reply_to_id: string | null
    root_id: string | null
    created_at: string
    updated_at: string
  }>
  attachments: Array<{
    id: string
    issue_id: string
    display_name: string
    content_type: string
    sha256: string
    content: string
    created_at: string
  }>
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('')
}

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return btoa(text)
}

async function allIssues(
  api: SharedWorkspaceApi,
  projectId: string
): Promise<CollaborationIssue[]> {
  const items = await api.issues.list(projectId)
  let cursor: string | null | undefined
  do {
    const page = await api.issues.listArchived(projectId, { cursor, limit: 100 })
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return [...new Map(items.map(issue => [issue.id, issue])).values()]
}

/** Only shared Issue messages and attachment bytes are exported; never read Runtime transcripts. */
export async function readLocalProjectImport(
  api: SharedWorkspaceApi,
  chat: ProjectChatClient,
  project: CollaborationProject,
  source: string,
  localUserId: number
): Promise<LocalProjectImport> {
  const current = await api.projects.get(project.id)
  const items = await allIssues(api, project.id)
  const snapshot: LocalProjectImport = {
    source,
    local_user_id: localUserId,
    source_project_id: project.id,
    milestones: ((await api.milestones?.list(project.id)) ?? []).map(
      ({ id, title, description, state, due_on }) => ({ id, title, description, state, due_on })
    ),
    name: current.name,
    description: current.description,
    settings: Object.fromEntries(
      ['tags', 'board_config', 'board_views', 'card_display', 'default_issue_security']
        .filter(key => current[key as keyof CollaborationProject] !== undefined)
        .map(key => [key, current[key as keyof CollaborationProject]])
    ),
    issues: [],
    comments: [],
    attachments: [],
  }
  for (const issue of items) {
    snapshot.issues.push({
      id: issue.id,
      version: issue.version,
      milestone_id: issue.milestone_id ?? null,
      security_level: issue.security_level ?? current.default_issue_security ?? 'open',
      assignee_user_id: issue.assignee_user_id,
      parent_id: issue.parent_id ?? null,
      title: issue.title,
      description: issue.description ?? '',
      status: issue.status,
      priority: issue.priority,
      sequence_number: issue.sequence_number,
      sort_order: issue.sort_order,
      tags: issue.tags ?? [],
      due_at: issue.due_at ?? null,
      start_at: issue.start_at ?? null,
      archived_at: issue.archived_at ?? null,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
    })
    const { snapshot: activity, unsubscribe } = await chat.subscribe(
      project.id,
      issue.id,
      0,
      () => {}
    )
    unsubscribe()
    if (
      activity.messages.some(
        message => message.status === 'pending' || message.status === 'streaming'
      )
    ) {
      throw new Error('local_project_public_activity_running')
    }
    for (const comment of activity.messages) {
      if (comment.type === 'agent_chunk') continue
      snapshot.comments.push({
        id: comment.messageId,
        issue_id: issue.id,
        author: comment.sender.name,
        body: comment.content,
        reply_to_id: comment.replyToMessageId ?? null,
        root_id: comment.rootMessageId ?? null,
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
      })
    }
    for (const file of await api.attachments.list(issue.id)) {
      const blob = await api.attachments.read(file.id, { projectId: project.id, issueId: issue.id })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const hash = await sha256(bytes)
      snapshot.attachments.push({
        id: file.id,
        issue_id: issue.id,
        display_name: file.display_name,
        content_type: file.content_type ?? blob.type ?? 'application/octet-stream',
        sha256: hash,
        content: base64(bytes),
        created_at: file.created_at ?? issue.created_at,
      })
    }
  }
  return snapshot
}

interface MigrationJournal {
  projectKey: string
  targetId?: string
  fingerprint?: string
  digest?: string
}

export async function migrateLocalProject({
  sourceApi,
  targetApi,
  chat,
  http,
  project,
  source,
  userId,
  sourceGuard,
  onProgress,
}: {
  sourceApi: SharedWorkspaceApi
  targetApi: SharedWorkspaceApi
  chat: ProjectChatClient
  http: HttpClient
  project: CollaborationProject
  source: string
  userId: number
  sourceGuard: {
    read(): Promise<LocalProjectMigrationSnapshot>
    archive(version: number, fingerprint: string, target: string): Promise<void>
  }
  onProgress?(stage: 'reading' | 'uploading' | 'finishing'): void
}): Promise<CollaborationProject> {
  onProgress?.('reading')
  const journalKey = `wework.project-migration:${await sha256(new TextEncoder().encode(`${userId}:${source}`))}`
  const raw = localStorage.getItem(journalKey)
  const journal: MigrationJournal = raw
    ? JSON.parse(raw)
    : { projectKey: `MIG${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}` }
  const persist = () => localStorage.setItem(journalKey, JSON.stringify(journal))
  const before = await sourceGuard.read()
  if (before.archived) {
    if (
      !journal.targetId ||
      before.migration_target !== journal.targetId ||
      before.migration_fingerprint !== journal.fingerprint
    )
      throw new Error('local_project_changed_during_migration')
    const target = await targetApi.projects.get(journal.targetId)
    const marker = await http.get<{ source: string; sha256: string }>(
      `/v1/cloud-projects/${encodeURIComponent(target.id)}/import-local`
    )
    if (marker?.source !== source || marker.sha256 !== journal.digest)
      throw new Error('local_project_changed_during_migration')
    localStorage.removeItem(journalKey)
    return target
  }
  if (journal.targetId && journal.fingerprint !== before.fingerprint)
    throw new Error('local_project_changed_during_migration')
  const snapshot = await readLocalProjectImport(sourceApi, chat, project, source, userId)
  if ((await sourceGuard.read()).fingerprint !== before.fingerprint)
    throw new Error('local_project_changed_during_migration')
  persist()
  let target = (await targetApi.projects.list()).find(
    item => item.project_key === journal.projectKey
  )
  if (!target) {
    try {
      target = await targetApi.projects.create({
        name: project.name,
        description: project.description,
        projectKey: journal.projectKey,
        taskProvider: 'local',
        visibility: 'private',
        membershipMode: 'restricted',
        includeDefaultAgent: false,
      })
    } catch (error) {
      target = (await targetApi.projects.list()).find(
        item => item.project_key === journal.projectKey
      )
      if (!target) throw error
    }
  }
  onProgress?.('uploading')
  const imported = await http.post<{ sha256: string }>(
    `/v1/cloud-projects/${encodeURIComponent(target.id)}/import-local`,
    snapshot
  )
  journal.targetId = target.id
  journal.fingerprint = before.fingerprint
  journal.digest = imported.sha256
  persist()
  onProgress?.('finishing')
  const cloudProject = await targetApi.projects.get(target.id)
  try {
    await sourceGuard.archive(before.version, before.fingerprint, target.id)
  } catch (error) {
    const after = await sourceGuard.read()
    if (
      after.archived &&
      after.migration_target === target.id &&
      after.migration_fingerprint === before.fingerprint
    ) {
      localStorage.removeItem(journalKey)
      return cloudProject
    }
    if (after.fingerprint !== before.fingerprint) {
      await targetApi.projects.archive(cloudProject.id, cloudProject.version)
      localStorage.removeItem(journalKey)
      throw new Error('local_project_changed_during_migration', { cause: error })
    }
    throw error
  }
  localStorage.removeItem(journalKey)
  return cloudProject
}
