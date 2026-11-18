import type {
  AssistantExecutionRequest,
  AssistantRequestAction,
  AssistantRequestList,
  AssistantRequestsApi,
} from '@wegent/collaboration'

export interface AssistantRequestScope {
  accountKey: string
  userId: number
  projectId: string
  issueId: string
}
export type RequestComposer = {
  action: 'new_request' | 'followup' | 'replace'
  requestId?: string
}
type Mutation =
  | AssistantRequestAction
  | {
      action: 'confirm_merge'
      requestId: string
      targetRevision: string
      candidateRevision: string
    }
export interface LocalRequestSubmission {
  clientId: string
  idempotencyKey: string
  action: Mutation
  state: 'queued' | 'sending' | 'failed' | 'preserved' | 'confirmed'
  requestId?: string
}
interface Draft {
  text: string
  revision: number
}
interface Snapshot {
  list: AssistantRequestList | null
  failed: boolean
  loading: boolean
  composer: RequestComposer | null
  drafts: Record<string, Draft>
  submissions: LocalRequestSubmission[]
}

const emptyDraft: Draft = { text: '', revision: 0 }
const stores = new Map<string, AssistantRequestScopeStore>()
const draftKey = (composer: RequestComposer) =>
  JSON.stringify([composer.action, composer.requestId])
const lane = (entry: LocalRequestSubmission) =>
  JSON.stringify(
    'requestId' in entry.action ? ['request', entry.action.requestId] : ['local', entry.clientId]
  )
const isMessage = (entry: LocalRequestSubmission) => 'message' in entry.action
const unfinished = (entry: LocalRequestSubmission) =>
  entry.state !== 'confirmed' && entry.state !== 'preserved'
const latestRequest = (
  incoming: AssistantExecutionRequest,
  current: AssistantExecutionRequest | undefined
) =>
  current && Date.parse(current.updatedAt) > Date.parse(incoming.updatedAt) ? current : incoming

export function assistantRequestScopeStore(scope: AssistantRequestScope) {
  const key = JSON.stringify([scope.accountKey, scope.userId, scope.projectId, scope.issueId])
  let store = stores.get(key)
  if (!store) {
    store = new AssistantRequestScopeStore(scope)
    stores.set(key, store)
  }
  return store
}
export function clearAssistantRequestScopesForTests() {
  for (const store of stores.values()) store.detachAll()
  stores.clear()
}

/** Local admission belongs to the owner scope; a mounted view only leases its transport. */
export class AssistantRequestScopeStore {
  private snapshot: Snapshot = {
    list: null,
    failed: false,
    loading: true,
    composer: null,
    drafts: {},
    submissions: [],
  }
  private listeners = new Set<() => void>()
  private bindings = new Map<symbol, AssistantRequestsApi>()
  private inFlight = new Map<string, string>()
  private read: Promise<void> | null = null
  private sequence = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private scheduled = false
  private readonly scope: AssistantRequestScope

  constructor(scope: AssistantRequestScope) {
    this.scope = scope
  }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach(listener => listener())
  }
  private api() {
    return [...this.bindings.values()].at(-1)
  }

  attach(api: AssistantRequestsApi) {
    const token = Symbol('assistant-request-owner')
    this.bindings.set(token, api)
    void this.refresh()
    this.schedule()
    return () => {
      this.bindings.delete(token)
      if (!this.bindings.size) clearTimeout(this.timer)
    }
  }
  detachAll() {
    this.bindings.clear()
    clearTimeout(this.timer)
  }
  refresh = () => {
    const api = this.api()
    if (!api || this.read) return this.read ?? Promise.resolve()
    clearTimeout(this.timer)
    const sequence = ++this.sequence
    this.update({ loading: true, failed: false })
    this.read = api
      .list(this.scope.projectId, this.scope.issueId)
      .then(list => {
        if (list.requests.some(request => request.ownerUserId !== this.scope.userId))
          throw new Error('Assistant request owner mismatch')
        this.update({
          ...(sequence === this.sequence ? { list } : {}),
          loading: false,
          failed: false,
        })
      })
      .catch(() => {
        this.update({ failed: true, loading: false })
      })
      .finally(() => {
        this.read = null
        if (
          this.bindings.size &&
          (this.snapshot.list?.enabled || this.snapshot.list?.requests.length)
        )
          this.timer = setTimeout(() => void this.refresh(), 5000)
      })
    return this.read
  }
  openComposer(composer: RequestComposer) {
    this.update({ composer })
  }
  closeComposer() {
    this.update({ composer: null })
  }
  draft() {
    return this.snapshot.composer
      ? (this.snapshot.drafts[draftKey(this.snapshot.composer)] ?? emptyDraft)
      : emptyDraft
  }
  setMessage(text: string) {
    const composer = this.snapshot.composer
    const current = this.draft()
    if (!composer || current.text === text) return
    this.update({
      drafts: {
        ...this.snapshot.drafts,
        [draftKey(composer)]: { text, revision: current.revision + 1 },
      },
    })
  }
  private allowed(action: Mutation) {
    const list = this.snapshot.list
    if (!list) return false
    if ((action.action === 'new_request' || action.action === 'replace') && !list.enabled)
      return false
    return (
      !('requestId' in action) ||
      list.requests.some(request => request.requestId === action.requestId)
    )
  }
  private entry(action: Mutation): LocalRequestSubmission {
    const clientId = crypto.randomUUID()
    return { clientId, idempotencyKey: clientId, action, state: 'queued' }
  }
  admit() {
    const composer = this.snapshot.composer
    const draft = this.draft()
    if (!composer || !draft.text.trim() || !this.bindings.size) return false
    const action: AssistantRequestAction =
      composer.action === 'new_request'
        ? { action: 'new_request', message: draft.text.trim() }
        : { action: composer.action, requestId: composer.requestId!, message: draft.text.trim() }
    if (!this.allowed(action)) return false
    this.update({
      submissions: [...this.snapshot.submissions, this.entry(action)],
      drafts: {
        ...this.snapshot.drafts,
        [draftKey(composer)]: { text: '', revision: draft.revision + 1 },
      },
    })
    this.schedule()
    return true
  }
  submitControl(action: Mutation) {
    if (!this.bindings.size || !this.allowed(action)) return false
    if ('requestId' in action && this.busy(action.requestId)) return false
    const previous =
      action.action === 'cancel'
        ? this.snapshot.submissions.map(entry =>
            isMessage(entry) &&
            'requestId' in entry.action &&
            entry.action.requestId === action.requestId &&
            unfinished(entry)
              ? { ...entry, state: 'preserved' as const }
              : entry
          )
        : this.snapshot.submissions
    this.update({ submissions: [...previous, this.entry(action)] })
    this.schedule()
    return true
  }
  busy(requestId: string) {
    return this.snapshot.submissions.some(
      entry =>
        !isMessage(entry) &&
        'requestId' in entry.action &&
        entry.action.requestId === requestId &&
        (entry.state === 'queued' || entry.state === 'sending')
    )
  }
  retry(clientId: string) {
    if (!this.bindings.size || this.inFlight.has(clientId)) return
    const entry = this.snapshot.submissions.find(entry => entry.clientId === clientId)
    if (!entry || !['failed', 'preserved'].includes(entry.state)) return
    if (!isMessage(entry) && 'requestId' in entry.action && this.busy(entry.action.requestId))
      return
    this.patch(clientId, entry => ({ ...entry, state: 'queued' }))
    this.schedule()
  }
  isInFlight(clientId: string) {
    return this.inFlight.has(clientId)
  }
  private patch(
    clientId: string,
    change: (entry: LocalRequestSubmission) => LocalRequestSubmission
  ) {
    this.update({
      submissions: this.snapshot.submissions.map(entry =>
        entry.clientId === clientId ? change(entry) : entry
      ),
    })
  }
  private schedule() {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.pump()
    })
  }
  private pump() {
    const api = this.api()
    if (!api) return
    const entries = this.snapshot.submissions
    let slots = 2 - this.inFlight.size
    const claimed = new Set(this.inFlight.values())
    for (const [index, entry] of entries.entries()) {
      if (this.api() !== api) return
      if (entry.state !== 'queued') continue
      const key = lane(entry)
      const sameObject = entries.filter(candidate => lane(candidate) === key)
      const earlier = entries.slice(0, index).filter(candidate => lane(candidate) === key)
      const blocked = isMessage(entry)
        ? sameObject.some(candidate => !isMessage(candidate) && candidate.state === 'queued') ||
          earlier.some(candidate => isMessage(candidate) && unfinished(candidate))
        : earlier.some(candidate => !isMessage(candidate) && candidate.state === 'queued')
      if (slots > 0 && !claimed.has(key) && !blocked) {
        slots--
        claimed.add(key)
        void this.deliver(api, entry)
      }
    }
  }
  private async deliver(api: AssistantRequestsApi, entry: LocalRequestSubmission) {
    this.inFlight.set(entry.clientId, lane(entry))
    this.patch(entry.clientId, current => ({ ...current, state: 'sending' }))
    try {
      if (this.api() !== api) {
        this.patch(entry.clientId, current =>
          current.state === 'sending' ? { ...current, state: 'queued' } : current
        )
        return
      }
      const { projectId, issueId, userId } = this.scope
      const { action, idempotencyKey } = entry
      const request: AssistantExecutionRequest =
        action.action === 'confirm_merge'
          ? await api.confirmMerge(projectId, issueId, action.requestId, {
              idempotencyKey,
              targetRevision: action.targetRevision,
              candidateRevision: action.candidateRevision,
            })
          : await api.submit(projectId, issueId, { ...action, idempotencyKey })
      if (request.ownerUserId !== userId) throw new Error('Assistant request owner mismatch')
      ++this.sequence
      const list = this.snapshot.list
      this.update({
        list: {
          enabled: list?.enabled === true,
          requests: [
            latestRequest(
              request,
              list?.requests.find(row => row.requestId === request.requestId)
            ),
            ...(list?.requests ?? []).filter(row => row.requestId !== request.requestId),
          ],
        },
        submissions: this.snapshot.submissions.map(current =>
          current.clientId === entry.clientId
            ? { ...current, state: 'confirmed', requestId: request.requestId }
            : current
        ),
      })
      void this.refresh()
    } catch {
      this.patch(entry.clientId, current =>
        current.state === 'preserved' ? current : { ...current, state: 'failed' }
      )
    } finally {
      this.inFlight.delete(entry.clientId)
      this.update({})
      this.schedule()
    }
  }
}
