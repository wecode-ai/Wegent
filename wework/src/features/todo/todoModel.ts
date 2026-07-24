import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '@/lib/runtime-environment'
import type { Attachment, RuntimeTaskAddress } from '@/types/api'
import type { TodoViewState } from './TodoDetailPanel'

export type TodoPrincipalType = 'unassigned' | 'human' | 'ai'

export interface TodoPrincipal {
  type: TodoPrincipalType
  id?: string
  name?: string
}

export interface TodoWorkType {
  key: string
  name: string
  dependsOn: string[]
  defaultAssignee: TodoPrincipal
}

export interface TodoWorkflowStatus {
  key: TodoViewState
  name: string
}

export interface TodoWorkflowConfig {
  version: 1
  statuses: TodoWorkflowStatus[]
  workTypes: TodoWorkType[]
}

export interface LocalWorkItem {
  id: string
  projectId: number
  parentId?: string
  title: string
  objective: string
  description: string
  state: TodoViewState
  workTypeKey?: string
  workTypeSnapshot?: TodoWorkType
  assignee: TodoPrincipal
  collaborators: TodoPrincipal[]
  confirmer?: TodoPrincipal
  blocker: string
  nextAction: string
  priority: 'none' | 'low' | 'normal' | 'high' | 'urgent'
  dueDate?: string
  attachments: Attachment[]
  runtimeRefs: RuntimeTaskAddress[]
  events: TodoWorkItemEvent[]
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface TodoWorkItemEvent {
  id: string
  type: 'created' | 'updated' | 'run-linked' | 'confirmed'
  summary: string
  createdAt: string
}

export interface TodoWorkspaceEntry {
  path: string
  name: string
  nodeType: 'file' | 'directory'
  size: number
  modifiedAtMs: number
  absolutePath: string
}

export const DEFAULT_TODO_WORKFLOW: TodoWorkflowConfig = {
  version: 1,
  statuses: [
    { key: 'inbox', name: '收集箱' },
    { key: 'backlog', name: '待开始' },
    { key: 'started', name: '进行中' },
    { key: 'review', name: '待确认' },
    { key: 'completed', name: '已完成' },
  ],
  workTypes: [],
}

export const TODO_WORKFLOW_TEMPLATES: Array<{
  key: string
  name: string
  workTypes: TodoWorkType[]
}> = [
  { key: 'personal', name: '个人事项', workTypes: [] },
  {
    key: 'software',
    name: '软件交付',
    workTypes: [
      { key: 'discovery', name: '需求', dependsOn: [], defaultAssignee: { type: 'human' } },
      {
        key: 'implementation',
        name: '实现',
        dependsOn: ['discovery'],
        defaultAssignee: { type: 'ai' },
      },
      {
        key: 'verification',
        name: '验证',
        dependsOn: ['implementation'],
        defaultAssignee: { type: 'human' },
      },
    ],
  },
  {
    key: 'content',
    name: '内容发布',
    workTypes: [
      { key: 'draft', name: '撰写', dependsOn: [], defaultAssignee: { type: 'human' } },
      {
        key: 'review',
        name: '审核',
        dependsOn: ['draft'],
        defaultAssignee: { type: 'human' },
      },
      {
        key: 'publish',
        name: '发布',
        dependsOn: ['review'],
        defaultAssignee: { type: 'ai' },
      },
    ],
  },
]

const STORE_PREFIX = 'wework:todo:work-items'
const WORKFLOW_PREFIX = 'wework:todo:workflow'

function scope(userId: number | undefined): string {
  return String(userId ?? 'local').replace(/[^a-zA-Z0-9_-]/g, '_')
}

function storageKey(userId: number | undefined): string {
  return `${STORE_PREFIX}:${scope(userId)}`
}

function migrateLegacyDrafts(userId: number | undefined): LocalWorkItem[] {
  try {
    const legacyKey = `wework:todo:drafts:${userId ?? 'local'}`
    const drafts = JSON.parse(window.localStorage.getItem(legacyKey) ?? '[]') as Array<{
      id: string
      projectId: number
      state: TodoViewState
      title: string
      markdown?: string
      goal?: string
      priority?: LocalWorkItem['priority']
      assignee?: TodoPrincipalType
      dueDate?: string
      attachments?: Attachment[]
      createdAt: string
      updatedAt: string
    }>
    if (!Array.isArray(drafts) || drafts.length === 0) return []
    const items = drafts.map(
      (draft): LocalWorkItem => ({
        id: draft.id,
        projectId: draft.projectId,
        state: draft.state,
        title: draft.title,
        description: draft.markdown ?? '',
        objective: draft.goal ?? '',
        priority: draft.priority ?? 'none',
        assignee: { type: draft.assignee ?? 'unassigned' },
        collaborators: [],
        blocker: '',
        nextAction: '',
        dueDate: draft.dueDate,
        attachments: draft.attachments ?? [],
        runtimeRefs: [],
        events: [
          {
            id: createLocalWorkItemId(),
            type: 'created',
            summary: 'Migrated from local draft',
            createdAt: draft.createdAt,
          },
        ],
        sortOrder: 0,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
      })
    )
    window.localStorage.setItem(storageKey(userId), JSON.stringify(items))
    window.localStorage.removeItem(legacyKey)
    return items
  } catch {
    return []
  }
}

export function loadLocalWorkItems(userId: number | undefined): LocalWorkItem[] {
  try {
    const raw = window.localStorage.getItem(storageKey(userId))
    if (!raw) return migrateLegacyDrafts(userId)
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.map(normalizeWorkItem) : []
  } catch {
    return []
  }
}

export async function hydrateLocalWorkItems(userId: number | undefined): Promise<LocalWorkItem[]> {
  if (!isTauriRuntime()) return loadLocalWorkItems(userId)
  try {
    const raw = await invoke<string | null>('load_todo_store', { scope: scope(userId) })
    if (!raw) return loadLocalWorkItems(userId)
    const items = (JSON.parse(raw) as LocalWorkItem[]).map(normalizeWorkItem)
    window.localStorage.setItem(storageKey(userId), JSON.stringify(items))
    return items
  } catch {
    return loadLocalWorkItems(userId)
  }
}

export function saveLocalWorkItems(userId: number | undefined, items: LocalWorkItem[]): void {
  const contents = JSON.stringify(items)
  window.localStorage.setItem(storageKey(userId), contents)
  if (isTauriRuntime()) {
    void invoke('save_todo_store', { scope: scope(userId), contents }).catch(error => {
      console.error('Failed to persist local TODO store', error)
    })
  }
}

export async function ensureTodoWorkspace(item: LocalWorkItem): Promise<string | null> {
  if (!isTauriRuntime()) return null
  try {
    return await invoke<string>('ensure_todo_workspace', {
      itemId: item.id,
      title: item.title,
      objective: item.objective || item.description,
    })
  } catch {
    return null
  }
}

export async function ensureTodoWorkDirectory(
  rootItemId: string,
  workType: string
): Promise<string | null> {
  if (!isTauriRuntime()) return null
  try {
    return await invoke<string>('ensure_todo_work_directory', { itemId: rootItemId, workType })
  } catch {
    return null
  }
}

export async function listTodoWorkspace(itemId: string): Promise<TodoWorkspaceEntry[]> {
  if (!isTauriRuntime()) return []
  try {
    return await invoke<TodoWorkspaceEntry[]>('list_todo_workspace', { itemId })
  } catch {
    return []
  }
}

export async function writeTodoWorkspaceFile(
  itemId: string,
  relativePath: string,
  file: File
): Promise<string | null> {
  if (!isTauriRuntime()) return null
  try {
    return await invoke<string>('write_todo_workspace_file', {
      itemId,
      relativePath,
      bytes: [...new Uint8Array(await file.arrayBuffer())],
    })
  } catch {
    return null
  }
}

export async function renameTodoWorkspaceEntry(
  itemId: string,
  fromPath: string,
  toPath: string
): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('rename_todo_workspace_entry', { itemId, fromPath, toPath })
}

export async function deleteTodoWorkspaceEntry(
  itemId: string,
  relativePath: string
): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('delete_todo_workspace_entry', { itemId, relativePath })
}

export async function getTodoWorkspacePath(itemId: string): Promise<string | null> {
  if (!isTauriRuntime()) return null
  try {
    return await invoke<string>('get_todo_workspace_path', { itemId })
  } catch {
    return null
  }
}

export function createLocalWorkItemId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `todo-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

export function loadTodoWorkflow(projectId: number | null): TodoWorkflowConfig {
  if (projectId == null) return DEFAULT_TODO_WORKFLOW
  try {
    const value = JSON.parse(
      window.localStorage.getItem(`${WORKFLOW_PREFIX}:${projectId}`) ?? 'null'
    ) as TodoWorkflowConfig | null
    return value?.version === 1
      ? {
          ...value,
          workTypes: value.workTypes.map(workType => ({
            ...workType,
            dependsOn: workType.dependsOn ?? [],
            defaultAssignee: workType.defaultAssignee ?? { type: 'unassigned' },
          })),
        }
      : DEFAULT_TODO_WORKFLOW
  } catch {
    return DEFAULT_TODO_WORKFLOW
  }
}

function normalizeWorkItem(item: LocalWorkItem): LocalWorkItem {
  return {
    ...item,
    assignee: item.assignee ?? { type: 'unassigned' },
    collaborators: item.collaborators ?? [],
    blocker: item.blocker ?? '',
    nextAction: item.nextAction ?? '',
    attachments: item.attachments ?? [],
    runtimeRefs: item.runtimeRefs ?? [],
    events: item.events ?? [],
    sortOrder: item.sortOrder ?? 0,
    workTypeSnapshot: item.workTypeSnapshot
      ? {
          ...item.workTypeSnapshot,
          dependsOn: item.workTypeSnapshot.dependsOn ?? [],
          defaultAssignee: item.workTypeSnapshot.defaultAssignee ?? { type: 'unassigned' },
        }
      : undefined,
  }
}

export function saveTodoWorkflow(projectId: number, config: TodoWorkflowConfig): void {
  window.localStorage.setItem(`${WORKFLOW_PREFIX}:${projectId}`, JSON.stringify(config))
}
