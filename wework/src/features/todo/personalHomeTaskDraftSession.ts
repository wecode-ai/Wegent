import type { IssueHomeTaskComposerProps } from '@wegent/collaboration/platform'
import type { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import type { PersonalHomeTaskDraft, PersonalHomeTaskDrafts } from './personalHomeTaskDrafts'

type AttachmentSource = ReturnType<typeof useWorkbenchAttachments>['source']
type InputOwner = { notify(): void }

/** Task text, Goal and imported File identities belong to one project draft. */
export class PersonalHomeTaskDraftSession {
  private readonly source: AttachmentSource
  private readonly drafts: PersonalHomeTaskDrafts
  private readonly projectKey: string | null
  private initial: PersonalHomeTaskDraft | undefined
  private owners = new Set<InputOwner>()
  private detach: (() => void) | undefined
  private restored = false
  private activated = false
  private selectedInputFiles: File[] = []
  private syncing = false
  private lastParentValue: string
  private rawValue: string
  private restoringFiles: File[] | undefined
  private uploaded: Set<File>
  private completed: string | null = null
  private snapshot: {
    value: string
    goalDraftActive: boolean
    error: string | null
    attachments: ReturnType<AttachmentSource['getSnapshot']>
  }

  constructor({
    source,
    drafts,
    projectKey,
    initial,
    value,
  }: {
    source: AttachmentSource
    drafts: PersonalHomeTaskDrafts
    projectKey: string | null
    initial?: PersonalHomeTaskDraft
    value: string
  }) {
    this.source = source
    this.drafts = drafts
    this.projectKey = projectKey
    this.initial = initial
    this.lastParentValue = value
    this.rawValue = initial?.value ?? value
    this.restoringFiles = initial ? (initial.pendingFiles ?? []) : undefined
    this.uploaded = new Set(initial?.attachmentFiles?.values())
    this.snapshot = {
      value: initial?.value ?? value,
      goalDraftActive: initial?.goalDraftActive ?? false,
      error: null,
      attachments: source.getSnapshot(),
    }
  }

  getSnapshot = () => this.snapshot

  observe(input: IssueHomeTaskComposerProps, notify: () => void): () => void {
    const owner = { notify }
    this.owners.add(owner)
    if (!this.detach) this.detach = this.source.subscribe(this.onAttachments, true)
    this.syncing = true
    try {
      if (input.active !== false) {
        this.activated = true
        this.restore(input)
        if (this.lastParentValue !== input.value) {
          this.lastParentValue = input.value
          this.rawValue = input.value
          this.snapshot = { ...this.snapshot, value: input.value }
        }
        this.syncFiles(input)
        this.cache()
      }
    } finally {
      this.syncing = false
    }
    this.onAttachments()
    return () => {
      this.owners.delete(owner)
      queueMicrotask(() => {
        if (this.owners.size) return
        this.cache()
        this.detach?.()
        this.detach = undefined
        this.restored = false
      })
    }
  }

  private restore(input: IssueHomeTaskComposerProps) {
    if (this.restored || !this.projectKey) return
    this.restored = true
    const saved = this.drafts.get(this.projectKey) ?? this.initial
    this.initial = undefined
    if (!saved) return
    this.lastParentValue = input.value
    this.rawValue = saved.value
    this.restoringFiles = saved.pendingFiles ?? []
    this.uploaded = new Set(saved.attachmentFiles?.values())
    this.snapshot = { ...this.snapshot, value: saved.value, goalDraftActive: saved.goalDraftActive }
    input.onChange(saved.value)
    for (const file of input.pendingFiles ?? []) input.onRemovePendingFile(file)
    if (saved.pendingFiles?.length) input.onFileSelect(saved.pendingFiles)
    if (!this.source.getSnapshot().attachments.length)
      for (const attachment of saved.attachments) {
        const file = saved.attachmentFiles?.get(attachment.id)
        if (file) this.source.addExistingSourceAttachment(attachment, file)
        else this.source.addExistingAttachment(attachment)
      }
  }

  private syncFiles(input: IssueHomeTaskComposerProps) {
    const restoring = this.restoringFiles
    if (
      restoring &&
      restoring.length === (input.pendingFiles?.length ?? 0) &&
      restoring.every(file => input.pendingFiles?.includes(file))
    )
      this.restoringFiles = undefined
    const selected = new Set(restoring ?? input.pendingFiles ?? [])
    this.selectedInputFiles = [...selected]
    for (const file of this.uploaded) {
      if (selected.has(file)) continue
      this.uploaded.delete(file)
      void this.source.removeSourceFile(file).catch(cause => this.setError(String(cause)))
    }
    const files = [...selected].filter(file => !this.uploaded.has(file))
    files.forEach(file => this.uploaded.add(file))
    if (files.length) void this.source.handleTrackedFileSelect(files)
  }

  private onAttachments = () => {
    if (this.syncing) return
    this.snapshot = { ...this.snapshot, attachments: this.source.getSnapshot() }
    this.cache()
    this.notify()
  }

  private notify() {
    this.owners.forEach(owner => owner.notify())
  }

  setError = (error: string | null) => {
    if (this.snapshot.error === error) return
    this.snapshot = { ...this.snapshot, error }
    this.notify()
  }

  getValue = () => this.rawValue

  recordEdit = (value: string) => {
    this.rawValue = value
    this.cache()
  }

  setValue = (value: string) => {
    this.rawValue = value
    this.snapshot = { ...this.snapshot, value, error: null }
    this.cache()
    this.notify()
  }

  setGoal = (goalDraftActive: boolean) => {
    this.snapshot = { ...this.snapshot, goalDraftActive }
    this.cache()
    this.notify()
  }

  selectedFiles = (): File[] => this.restoringFiles ?? this.selectedInputFiles

  complete = (value: string) => {
    this.completed = value
    this.rawValue = ''
    this.restoringFiles = undefined
    this.selectedInputFiles = []
    this.uploaded.clear()
    this.snapshot = { ...this.snapshot, value: '' }
    this.notify()
  }

  private cache() {
    if (!this.projectKey || !this.activated) return
    const value = this.rawValue
    const { goalDraftActive } = this.snapshot
    const state = this.source.getSnapshot()
    if (this.completed !== null) {
      const resetApplied =
        !value.trim() &&
        !state.attachments.length &&
        !state.uploadingFiles.size &&
        !this.selectedFiles().length
      if (!resetApplied && (!value.trim() || value === this.completed)) return
      this.completed = null
    }
    const previous = this.drafts.get(this.projectKey)
    const pendingFiles = [
      ...new Set([
        ...this.selectedFiles(),
        ...[...state.uploadingFiles.values()].map(upload => upload.file),
      ]),
    ]
    const selected = this.source.getSelectedAttachments(pendingFiles)
    if (
      !previous?.issue &&
      !value.trim() &&
      !selected.length &&
      !pendingFiles.length &&
      !goalDraftActive
    ) {
      this.drafts.delete(this.projectKey)
      return
    }
    const attachmentFiles = new Map<number, File>()
    selected.forEach(attachment => {
      const file = this.source.getSourceFile(attachment.id)
      if (file) attachmentFiles.set(attachment.id, file)
    })
    this.drafts.set(this.projectKey, {
      ...previous,
      value,
      requestedTitle: previous?.requestedTitle ?? '',
      pendingContentUpdate: Boolean(
        previous?.pendingContentUpdate || (previous?.issue && previous.value !== value)
      ),
      attachments: selected.map(attachment => {
        const copy = { ...attachment }
        delete copy.local_preview_url
        return copy
      }),
      pendingFiles,
      attachmentFiles,
      goalDraftActive,
    })
  }
}
