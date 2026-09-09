import { randomUUID } from 'node:crypto'

export interface BrowserAnnotationRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserElementAnchor {
  kind: 'element'
  pageUrl: string
  frameUrl: string
  framePath: string[]
  selector: string
  elementPath: string[]
  tagName: string
  role?: string
  name?: string
  title?: string
  immediateText?: string
  nearbyText?: string
  rect: BrowserAnnotationRect
  fixedPosition: boolean
  scrollContainers: Array<{ selector: string; left: number; top: number }>
}

export interface BrowserDesignChange {
  property: string
  value: string
  previousValue: string
}

export interface BrowserAnnotationComment {
  id: string
  number: number
  comment: string
  anchor: BrowserElementAnchor
  designChanges: BrowserDesignChange[]
  textChange: { before: string; after: string } | null
  screenshotDataUrl: string | null
  createdAt: string
  updatedAt: string
}

interface BrowserPageRuntime {
  pageSessionId: string
  url: string
  title: string | null
}

interface BrowserAnnotationSession {
  label: string
  mode: 'off' | 'quick' | 'batch'
  runtime: BrowserPageRuntime | null
  runtimeRevision: number
  originalView: boolean
  unresolvedIds: string[]
}

export interface BrowserAnnotationDraft {
  label: string
  commentId: string | null
  anchor: BrowserElementAnchor
  comment: string
  designChanges: BrowserDesignChange[]
  designValues: Record<string, string>
  textChange: { before: string; after: string } | null
  screenshotDataUrl: string | null
  screenshotState: 'capturing' | 'ready' | 'failed'
}

export interface BrowserAnnotationState {
  label: string
  mode: BrowserAnnotationSession['mode']
  scope: {
    browserTabId: string
    pageSessionId: string
    url: string
  } | null
  revision: number
  runtimeRevision: number
  comments: BrowserAnnotationComment[]
  originalView: boolean
  unresolvedIds: string[]
}

interface BrowserAnnotationPage {
  capture(label: string, rect: BrowserAnnotationRect): Promise<string>
  labelForContentsId(contentsId: number): string | null
  send(label: string, channel: string, payload: unknown): void
  state(label: string): { title: string | null; url: string | null }
}

interface BrowserAnnotationControllerOptions {
  browser: BrowserAnnotationPage
  publish: (state: BrowserAnnotationState) => void
}

export class BrowserAnnotationController {
  private readonly sessions = new Map<string, BrowserAnnotationSession>()
  private readonly comments = new Map<string, BrowserAnnotationComment[]>()
  private readonly revisions = new Map<string, number>()
  private draft: BrowserAnnotationDraft | null = null

  constructor(private readonly options: BrowserAnnotationControllerOptions) {}

  start(
    label: string,
    mode: 'quick' | 'batch',
    point: { x: number; y: number } | null = null
  ): void {
    const session = this.session(label)
    session.mode = mode
    session.runtimeRevision += 1
    this.sync(label, point)
    this.publish(label)
  }

  stop(label: string): void {
    const session = this.session(label)
    session.mode = 'off'
    session.originalView = false
    session.runtimeRevision += 1
    if (this.draft?.label === label) this.closeDraft(false)
    this.sync(label)
    this.publish(label)
  }

  clear(label: string): void {
    const key = this.currentKey(label)
    if (key) {
      this.comments.delete(key)
      this.bump(key)
    }
    if (this.draft?.label === label) this.closeDraft(false)
    this.sync(label)
    this.publish(label)
  }

  setOriginalView(label: string, enabled: boolean): void {
    const session = this.session(label)
    session.originalView = enabled
    session.runtimeRevision += 1
    this.sync(label)
    this.publish(label)
  }

  state(label: string): BrowserAnnotationState {
    const session = this.session(label)
    const key = this.currentKey(label)
    const comments = key ? (this.comments.get(key) ?? []) : []
    return {
      label,
      mode: session.mode,
      scope: session.runtime
        ? {
            browserTabId: label,
            pageSessionId: session.runtime.pageSessionId,
            url: session.runtime.url,
          }
        : null,
      revision: key ? (this.revisions.get(key) ?? 0) : 0,
      runtimeRevision: session.runtimeRevision,
      comments,
      originalView: session.originalView,
      unresolvedIds: session.unresolvedIds,
    }
  }

  async saveDraft(input: {
    comment: string
    designChanges: BrowserDesignChange[]
    textChange?: { before: string; after: string } | null
  }): Promise<void> {
    const draft = this.requiredDraft()
    const commentText = input.comment.trim()
    if (!commentText && input.designChanges.length === 0) {
      throw new Error('Browser annotation comment or design change is required')
    }
    const key = this.key(draft.label, draft.anchor.pageUrl)
    const existing = this.comments.get(key) ?? []
    const now = new Date().toISOString()
    const previous = draft.commentId
      ? existing.find(comment => comment.id === draft.commentId)
      : undefined
    const next: BrowserAnnotationComment = {
      id: previous?.id ?? randomUUID(),
      number: previous?.number ?? nextNumber(existing),
      comment: commentText,
      anchor: draft.anchor,
      designChanges: input.designChanges,
      textChange: input.textChange ?? null,
      screenshotDataUrl: draft.screenshotDataUrl,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    this.comments.set(
      key,
      previous
        ? existing.map(comment => (comment.id === previous.id ? next : comment))
        : [...existing, next]
    )
    this.bump(key)
    const mode = this.session(draft.label).mode
    const label = draft.label
    this.closeDraft(false)
    if (mode === 'quick') this.session(label).mode = 'off'
    this.sync(label)
    this.publish(label)
  }

  deleteDraftComment(): void {
    const draft = this.requiredDraft()
    if (!draft.commentId) {
      this.closeDraft()
      return
    }
    const key = this.key(draft.label, draft.anchor.pageUrl)
    const comments = this.comments.get(key) ?? []
    this.comments.set(
      key,
      comments.filter(comment => comment.id !== draft.commentId)
    )
    this.bump(key)
    const label = draft.label
    this.closeDraft(false)
    this.sync(label)
    this.publish(label)
  }

  closeDraft(syncRuntime = true): void {
    const label = this.draft?.label ?? null
    this.draft = null
    if (label && syncRuntime) this.sync(label)
  }

  handleRuntimeEvent(contentsId: number, payload: unknown): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
    const event = payload as Record<string, unknown>
    const type = typeof event.type === 'string' ? event.type : ''
    const label = this.options.browser.labelForContentsId(contentsId)
    if (!label) {
      console.warn('[browser-annotation] ignored event without browser label', {
        contentsId,
        type,
      })
      return
    }
    if (type !== 'runtime-ready') this.updateRuntimeLocation(label, event)
    if (type === 'runtime-ready') {
      this.runtimeReady(label, event)
      return
    }
    if (type === 'create-draft') {
      void this.createDraft(label, event)
      return
    }
    if (type === 'open-comment') {
      void this.openComment(label, event)
      return
    }
    if (type === 'save-draft') {
      if (this.draft?.label !== label) return
      void this.saveDraft({
        comment: stringValue(event.comment) ?? '',
        designChanges: designChanges(event.designChanges),
        textChange: textChange(event.textChange),
      })
      return
    }
    if (type === 'delete-draft') {
      if (this.draft?.label !== label) return
      this.deleteDraftComment()
      return
    }
    if (type === 'close-draft') {
      if (this.draft?.label !== label) return
      this.closeDraft()
      return
    }
    if (type === 'stop-annotation') {
      this.stop(label)
      return
    }
    if (type === 'anchors-updated') this.updateAnchors(label, event)
  }

  private updateRuntimeLocation(label: string, event: Record<string, unknown>): void {
    const pageSessionId = stringValue(event.pageSessionId)
    const url = stringValue(event.pageUrl)
    const session = this.session(label)
    if (
      !pageSessionId ||
      !url ||
      !session.runtime ||
      session.runtime.pageSessionId !== pageSessionId ||
      canonicalPageUrl(session.runtime.url) === canonicalPageUrl(url)
    ) {
      return
    }
    session.runtime = { ...session.runtime, url }
    session.runtimeRevision += 1
    session.unresolvedIds = []
  }

  closeLabel(label: string): void {
    if (this.draft?.label === label) this.closeDraft(false)
    this.sessions.delete(label)
  }

  private runtimeReady(label: string, event: Record<string, unknown>): void {
    const pageSessionId = stringValue(event.pageSessionId)
    const url = stringValue(event.pageUrl)
    if (!pageSessionId || !url) return
    const session = this.session(label)
    const navigated =
      session.runtime !== null && canonicalPageUrl(session.runtime.url) !== canonicalPageUrl(url)
    if (navigated) {
      session.mode = 'off'
      session.originalView = false
      if (this.draft?.label === label) this.closeDraft(false)
    }
    session.runtime = {
      pageSessionId,
      url,
      title: stringValue(event.title),
    }
    session.runtimeRevision += 1
    session.unresolvedIds = []
    this.sync(label)
    this.publish(label)
  }

  private async createDraft(label: string, event: Record<string, unknown>): Promise<void> {
    const anchor = elementAnchor(event.anchor)
    if (!anchor) {
      console.warn('[browser-annotation] ignored invalid draft anchor', { label })
      return
    }
    this.draft = {
      label,
      commentId: null,
      anchor,
      comment: '',
      designChanges: [],
      designValues: stringRecord(event.designValues),
      textChange: null,
      screenshotDataUrl: null,
      screenshotState: 'capturing',
    }
    this.sync(label)
    try {
      const screenshotDataUrl = await this.options.browser.capture(label, paddedRect(anchor.rect))
      if (!this.draft || this.draft.label !== label || this.draft.anchor !== anchor) return
      this.draft.screenshotDataUrl = screenshotDataUrl
      this.draft.screenshotState = 'ready'
    } catch {
      if (!this.draft || this.draft.label !== label || this.draft.anchor !== anchor) return
      this.draft.screenshotState = 'failed'
    }
    this.sync(label)
  }

  private async openComment(label: string, event: Record<string, unknown>): Promise<void> {
    const commentId = stringValue(event.commentId)
    if (!commentId) return
    const key = this.currentKey(label)
    const comment = key
      ? (this.comments.get(key) ?? []).find(candidate => candidate.id === commentId)
      : null
    if (!comment) return
    const updatedAnchor = elementAnchor(event.anchor)
    this.draft = {
      label,
      commentId: comment.id,
      anchor: updatedAnchor ?? comment.anchor,
      comment: comment.comment,
      designChanges: comment.designChanges,
      designValues: stringRecord(event.designValues),
      textChange: comment.textChange,
      screenshotDataUrl: comment.screenshotDataUrl,
      screenshotState: comment.screenshotDataUrl ? 'ready' : 'failed',
    }
    this.sync(label)
  }

  private updateAnchors(label: string, event: Record<string, unknown>): void {
    const session = this.session(label)
    const unresolvedIds = stringArray(event.unresolvedIds)
    let changed = !sameStringArray(session.unresolvedIds, unresolvedIds)
    session.unresolvedIds = unresolvedIds
    const key = this.currentKey(label)
    if (!key || !Array.isArray(event.anchors)) return
    const updates = new Map<string, BrowserElementAnchor>()
    for (const value of event.anchors) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      const commentId = stringValue(record.commentId)
      const anchor = elementAnchor(record.anchor)
      if (commentId && anchor) updates.set(commentId, anchor)
    }
    if (updates.size > 0) {
      const comments = this.comments.get(key) ?? []
      const nextComments = comments.map(comment => {
        const anchor = updates.get(comment.id)
        if (!anchor || sameAnchorIdentity(comment.anchor, anchor)) return comment
        changed = true
        return { ...comment, anchor }
      })
      if (changed) this.comments.set(key, nextComments)
    }
    if (!changed) return
    session.runtimeRevision += 1
    this.publish(label)
  }

  private sync(label: string, point: { x: number; y: number } | null = null): void {
    const session = this.session(label)
    const key = this.currentKey(label)
    const comments = key ? (this.comments.get(key) ?? []) : []
    this.send(label, {
      type: 'sync',
      point,
      state: {
        mode: session.mode,
        draft: this.draft?.label === label ? this.draft : null,
        comments: comments.map(comment => ({
          id: comment.id,
          number: comment.number,
          anchor: comment.anchor,
          designChanges: comment.designChanges,
          textChange: comment.textChange,
        })),
        originalView: session.originalView,
      },
    })
  }

  private send(label: string, command: Record<string, unknown>): void {
    try {
      this.options.browser.send(label, 'wework:browser-annotation-command', command)
    } catch (error) {
      console.warn('[browser-annotation] failed to send runtime command', {
        error: error instanceof Error ? error.message : String(error),
        label,
        type: command.type,
      })
      // The next runtime-ready event will receive the authoritative state.
    }
  }

  private publish(label: string): void {
    this.options.publish(this.state(label))
  }

  private session(label: string): BrowserAnnotationSession {
    const existing = this.sessions.get(label)
    if (existing) return existing
    const created: BrowserAnnotationSession = {
      label,
      mode: 'off',
      runtime: null,
      runtimeRevision: 0,
      originalView: false,
      unresolvedIds: [],
    }
    const browserState = safeBrowserState(this.options.browser, label)
    if (browserState.url) {
      created.runtime = {
        pageSessionId: '',
        url: browserState.url,
        title: browserState.title,
      }
    }
    this.sessions.set(label, created)
    return created
  }

  private currentKey(label: string): string | null {
    const url = this.session(label).runtime?.url
    return url ? this.key(label, url) : null
  }

  private key(label: string, url: string): string {
    return `${label}\n${canonicalPageUrl(url)}`
  }

  private bump(key: string): void {
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
  }

  private requiredDraft(): BrowserAnnotationDraft {
    if (!this.draft) throw new Error('Browser annotation draft is unavailable')
    return this.draft
  }
}

function safeBrowserState(browser: BrowserAnnotationPage, label: string) {
  try {
    return browser.state(label)
  } catch {
    return { title: null, url: null }
  }
}

function canonicalPageUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  } catch {
    return value
  }
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameAnchorIdentity(left: BrowserElementAnchor, right: BrowserElementAnchor): boolean {
  return (
    canonicalPageUrl(left.pageUrl) === canonicalPageUrl(right.pageUrl) &&
    left.frameUrl === right.frameUrl &&
    sameStringArray(left.framePath, right.framePath) &&
    left.selector === right.selector &&
    sameStringArray(left.elementPath, right.elementPath) &&
    left.tagName === right.tagName &&
    left.role === right.role &&
    left.name === right.name &&
    left.title === right.title &&
    left.immediateText === right.immediateText &&
    left.nearbyText === right.nearbyText &&
    left.fixedPosition === right.fixedPosition &&
    sameStringArray(
      left.scrollContainers.map(container => container.selector),
      right.scrollContainers.map(container => container.selector)
    )
  )
}

function nextNumber(comments: BrowserAnnotationComment[]): number {
  return Math.max(0, ...comments.map(comment => comment.number)) + 1
}

function paddedRect(rect: BrowserAnnotationRect): BrowserAnnotationRect {
  const padding = 24
  return {
    x: Math.max(0, Math.floor(rect.x - padding)),
    y: Math.max(0, Math.floor(rect.y - padding)),
    width: Math.max(1, Math.ceil(rect.width + padding * 2)),
    height: Math.max(1, Math.ceil(rect.height + padding * 2)),
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

function designChanges(value: unknown): BrowserDesignChange[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const property = stringValue(record.property)
    const designValue = stringValue(record.value)
    if (!property || designValue === null) return []
    return [
      {
        property,
        value: designValue,
        previousValue: typeof record.previousValue === 'string' ? record.previousValue : '',
      },
    ]
  })
}

function textChange(value: unknown): { before: string; after: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.before !== 'string' || typeof record.after !== 'string') return null
  return { before: record.before, after: record.after }
}

function elementAnchor(value: unknown): BrowserElementAnchor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const rect = browserRect(record.rect)
  const selector = stringValue(record.selector)
  const pageUrl = stringValue(record.pageUrl)
  const frameUrl = stringValue(record.frameUrl)
  const tagName = stringValue(record.tagName)
  if (record.kind !== 'element' || !rect || !selector || !pageUrl || !frameUrl || !tagName) {
    return null
  }
  return {
    kind: 'element',
    pageUrl,
    frameUrl,
    framePath: stringArray(record.framePath),
    selector,
    elementPath: stringArray(record.elementPath),
    tagName,
    role: stringValue(record.role) ?? undefined,
    name: stringValue(record.name) ?? undefined,
    title: stringValue(record.title) ?? undefined,
    immediateText: stringValue(record.immediateText) ?? undefined,
    nearbyText: stringValue(record.nearbyText) ?? undefined,
    rect,
    fixedPosition: record.fixedPosition === true,
    scrollContainers: Array.isArray(record.scrollContainers)
      ? record.scrollContainers.flatMap(value => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return []
          const item = value as Record<string, unknown>
          const selector = stringValue(item.selector)
          const left = numberValue(item.left)
          const top = numberValue(item.top)
          return selector && left !== null && top !== null ? [{ selector, left, top }] : []
        })
      : [],
  }
}

function browserRect(value: unknown): BrowserAnnotationRect | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const x = numberValue(record.x)
  const y = numberValue(record.y)
  const width = numberValue(record.width)
  const height = numberValue(record.height)
  return x !== null && y !== null && width !== null && height !== null
    ? { x, y, width, height }
    : null
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
