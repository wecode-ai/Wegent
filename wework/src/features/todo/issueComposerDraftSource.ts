import type { CloudLoopItem } from '@/api/deliveries'
import { releaseAttachmentPreview } from '@/lib/attachments'
import type { Attachment } from '@/types/api'

interface StagedIssueAttachment {
  attachment: Attachment
  file: File
}

export interface IssueComposerDraft {
  boardKey: string
  title: string
  content: string
  creationMode: 'issue' | 'task'
  localProjectId: number | null
  status: CloudLoopItem['status']
  priority: CloudLoopItem['priority']
  tags: string[]
  assigneeUserId: number | null
}

const issueDraftAttachmentStore = new Map<string, File[]>()

export function issueComposerDraftKey(
  boardKey: string,
  initialMode: IssueComposerDraft['creationMode']
): string {
  return `wework-issue-composer-draft:${boardKey}:${initialMode}`
}

function readIssueComposerDraft(key: string): IssueComposerDraft | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Partial<IssueComposerDraft>
    if (
      typeof parsed.boardKey !== 'string' ||
      typeof parsed.content !== 'string' ||
      (parsed.creationMode !== 'issue' && parsed.creationMode !== 'task')
    ) {
      return null
    }
    return {
      boardKey: parsed.boardKey,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      content: parsed.content,
      creationMode: parsed.creationMode,
      localProjectId: typeof parsed.localProjectId === 'number' ? parsed.localProjectId : null,
      status:
        typeof parsed.status === 'string' ? (parsed.status as CloudLoopItem['status']) : 'inbox',
      priority:
        parsed.priority === 'low' ||
        parsed.priority === 'medium' ||
        parsed.priority === 'high' ||
        parsed.priority === 'urgent'
          ? parsed.priority
          : 'none',
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
      assigneeUserId: typeof parsed.assigneeUserId === 'number' ? parsed.assigneeUserId : null,
    }
  } catch {
    return null
  }
}

interface IssueComposerSnapshot extends IssueComposerDraft {
  stagedAttachments: StagedIssueAttachment[]
  fullScreen: boolean
}

const draftWriters = new Map<string, symbol>()

function attachmentFromFile(file: File, id: number): Attachment {
  return {
    id,
    filename: file.name,
    file_size: file.size,
    mime_type: file.type || 'application/octet-stream',
    status: 'ready',
    file_extension: file.name.includes('.') ? (file.name.split('.').pop() ?? '') : '',
    created_at: new Date().toISOString(),
  }
}

export function hasIssueComposerDraft(snapshot: IssueComposerSnapshot): boolean {
  return Boolean(
    snapshot.title.trim() ||
    snapshot.content.trim() ||
    snapshot.tags.length ||
    snapshot.assigneeUserId ||
    snapshot.status !== 'inbox' ||
    snapshot.priority !== 'none' ||
    snapshot.stagedAttachments.length
  )
}

/** Owns one persisted draft and the preview resources displayed by its subscribers. */
export function createIssueComposerDraftSource({
  initialBoardKey,
  initialMode,
  initialContent,
  initialLocalProjectId,
}: {
  initialBoardKey: string
  initialMode: IssueComposerDraft['creationMode']
  initialContent: string
  initialLocalProjectId: number | null
}) {
  const key = issueComposerDraftKey(initialBoardKey, initialMode)
  const writer = Symbol(key)
  const saved = initialContent.trim() ? null : readIssueComposerDraft(key)
  const files = saved ? (issueDraftAttachmentStore.get(key) ?? []) : []
  let snapshot: IssueComposerSnapshot = {
    boardKey: saved?.boardKey ?? initialBoardKey,
    title: saved?.title ?? '',
    content: initialContent || saved?.content || '',
    creationMode: saved?.creationMode ?? initialMode,
    localProjectId: saved?.localProjectId ?? initialLocalProjectId,
    status: saved?.status ?? 'inbox',
    priority: saved?.priority ?? 'none',
    tags: saved?.tags ?? [],
    assigneeUserId: saved?.assigneeUserId ?? null,
    fullScreen: false,
    stagedAttachments: files.map((file, index) => ({
      file,
      attachment: attachmentFromFile(file, -(index + 1)),
    })),
  }
  const listeners = new Set<() => void>()
  let nextAttachmentId = -(files.length + 1)
  let revision = 0
  let subscriptionRevision = 0
  let consumed = false
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const removePersisted = () => {
    if (draftWriters.get(key) !== writer) return
    localStorage.removeItem(key)
    issueDraftAttachmentStore.delete(key)
    draftWriters.delete(key)
  }
  const persist = () => {
    if (consumed) return
    draftWriters.set(key, writer)
    if (!hasIssueComposerDraft(snapshot)) {
      removePersisted()
      return
    }
    const { stagedAttachments } = snapshot
    const draft: IssueComposerDraft = {
      boardKey: snapshot.boardKey,
      title: snapshot.title,
      content: snapshot.content,
      creationMode: snapshot.creationMode,
      localProjectId: snapshot.localProjectId,
      status: snapshot.status,
      priority: snapshot.priority,
      tags: snapshot.tags,
      assigneeUserId: snapshot.assigneeUserId,
    }
    localStorage.setItem(key, JSON.stringify(draft))
    if (stagedAttachments.length)
      issueDraftAttachmentStore.set(
        key,
        stagedAttachments.map(item => item.file)
      )
    else issueDraftAttachmentStore.delete(key)
  }
  const hydratePreviews = () => {
    if (!listeners.size || typeof URL.createObjectURL !== 'function') return
    let changed = false
    const stagedAttachments = snapshot.stagedAttachments.map(item => {
      if (!item.file.type.startsWith('image/') || item.attachment.local_preview_url) return item
      changed = true
      return {
        ...item,
        attachment: { ...item.attachment, local_preview_url: URL.createObjectURL(item.file) },
      }
    })
    if (changed) snapshot = { ...snapshot, stagedAttachments }
  }
  function update(patch: Partial<IssueComposerDraft>) {
    if (
      Object.entries(patch).every(
        ([field, value]) => snapshot[field as keyof IssueComposerDraft] === value
      )
    )
      return
    snapshot = { ...snapshot, ...patch }
    revision += 1
    consumed = false
    persist()
    notify()
  }
  function releasePreviews() {
    const stagedAttachments = snapshot.stagedAttachments.map(item => {
      releaseAttachmentPreview(item.attachment)
      const attachment = { ...item.attachment }
      delete attachment.local_preview_url
      return { ...item, attachment }
    })
    snapshot = { ...snapshot, stagedAttachments }
  }
  return {
    key,
    getSnapshot: () => snapshot,
    hasSubscribers: () => listeners.size > 0,
    subscribe(listener: () => void) {
      subscriptionRevision += 1
      listeners.add(listener)
      hydratePreviews()
      persist()
      return () => {
        listeners.delete(listener)
        const ticket = ++subscriptionRevision
        queueMicrotask(() => {
          if (listeners.size || ticket !== subscriptionRevision) return
          releasePreviews()
        })
      }
    },
    update,
    setFullScreen(fullScreen: boolean) {
      if (snapshot.fullScreen === fullScreen) return
      snapshot = { ...snapshot, fullScreen }
      notify()
    },
    stageFiles(input: File | File[]) {
      const selected = Array.isArray(input) ? input : [input]
      if (!selected.length) return
      snapshot = {
        ...snapshot,
        stagedAttachments: [
          ...snapshot.stagedAttachments,
          ...selected.map(file => ({
            file,
            attachment: attachmentFromFile(file, nextAttachmentId--),
          })),
        ],
      }
      revision += 1
      consumed = false
      hydratePreviews()
      persist()
      notify()
    },
    removeAttachment(id: number) {
      const removed = snapshot.stagedAttachments.find(item => item.attachment.id === id)
      if (!removed) return
      releaseAttachmentPreview(removed.attachment)
      snapshot = {
        ...snapshot,
        stagedAttachments: snapshot.stagedAttachments.filter(item => item !== removed),
      }
      revision += 1
      consumed = false
      persist()
      notify()
    },
    clear() {
      releasePreviews()
      snapshot = {
        ...snapshot,
        title: '',
        content: '',
        status: 'inbox',
        priority: 'none',
        tags: [],
        assigneeUserId: null,
        stagedAttachments: [],
      }
      revision += 1
      consumed = true
      removePersisted()
      notify()
    },
    captureSubmission() {
      const submittedRevision = revision
      const submittedOwner = draftWriters.get(key)
      return {
        accept(keepOpen: boolean, tags: string[]) {
          if (revision !== submittedRevision || draftWriters.get(key) !== submittedOwner)
            return false
          // A closed or replaced composer cannot clear a newer writer's draft.
          if (draftWriters.get(key) === submittedOwner) {
            localStorage.removeItem(key)
            issueDraftAttachmentStore.delete(key)
            draftWriters.delete(key)
          }
          consumed = true
          if (keepOpen) {
            releasePreviews()
            snapshot = { ...snapshot, title: '', content: '', tags, stagedAttachments: [] }
            revision += 1
            // Keep the selected defaults available for the next creation.
            consumed = false
            persist()
            notify()
          }
          return true
        },
      }
    },
  }
}
