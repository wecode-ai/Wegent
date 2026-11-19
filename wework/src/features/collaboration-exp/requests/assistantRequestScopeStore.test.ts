// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import type { AssistantExecutionRequest, AssistantRequestsApi } from '@wegent/collaboration'
import {
  assistantRequestScopeStore,
  clearAssistantRequestScopesForTests,
  type AssistantRequestScope,
} from './assistantRequestScopeStore'

afterEach(clearAssistantRequestScopesForTests)

const scope: AssistantRequestScope = {
  accountKey: 'backend-one:7',
  userId: 7,
  projectId: 'project',
  issueId: 'issue',
}
function request(overrides: Partial<AssistantExecutionRequest> = {}): AssistantExecutionRequest {
  return {
    requestId: 'a',
    ownerUserId: 7,
    parentRequestId: null,
    message: 'A',
    deviceId: 'device',
    runtimeTaskId: 'task',
    conversationId: 'conversation',
    executionId: '1',
    state: 'running',
    queuePosition: null,
    reasonCode: null,
    updatedAt: '2026-11-18T00:00:00Z',
    commands: [],
    ...overrides,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
async function fixture() {
  const api: AssistantRequestsApi = {
    list: vi.fn().mockResolvedValue({ enabled: true, requests: [request()] }),
    submit: vi.fn().mockResolvedValue(request()),
    confirmMerge: vi.fn().mockResolvedValue(request()),
  }
  const store = assistantRequestScopeStore(scope)
  const detach = store.attach(api)
  await store.refresh()
  return { api, store, detach }
}
function admit(
  store: ReturnType<typeof assistantRequestScopeStore>,
  text: string,
  requestId?: string
) {
  store.openComposer(requestId ? { action: 'followup', requestId } : { action: 'new_request' })
  store.setMessage(text)
  expect(store.admit()).toBe(true)
}

it('records the local message and clears its revision before transport, without consuming a later draft', async () => {
  const { api, store } = await fixture()
  const accepted = deferred<AssistantExecutionRequest>()
  vi.mocked(api.submit).mockReturnValueOnce(accepted.promise)
  admit(store, 'First')
  expect(store.getSnapshot().submissions[0]).toMatchObject({
    action: { action: 'new_request', message: 'First' },
    state: 'queued',
  })
  expect(store.getSnapshot().submissions[0]).not.toHaveProperty('requestId')
  expect(store.draft()).toEqual({ text: '', revision: 2 })
  expect(api.submit).not.toHaveBeenCalled()
  expect(store.admit()).toBe(false)
  store.setMessage('Later draft')
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1))
  accepted.resolve(request())
  await vi.waitFor(() => expect(store.getSnapshot().submissions[0].state).toBe('confirmed'))
  expect(store.draft().text).toBe('Later draft')
})

it('gives separately admitted identical text new identities and bounds concurrent independent sends', async () => {
  const { api, store } = await fixture()
  const pending = Array.from({ length: 3 }, () => deferred<AssistantExecutionRequest>())
  vi.mocked(api.submit).mockImplementation(
    () => pending[vi.mocked(api.submit).mock.calls.length - 1].promise
  )
  for (let i = 0; i < 3; i++) admit(store, 'Same text')
  const entries = store.getSnapshot().submissions
  expect(new Set(entries.map(entry => entry.idempotencyKey)).size).toBe(3)
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2))
  expect(store.getSnapshot().submissions.map(entry => entry.state)).toEqual([
    'sending',
    'sending',
    'queued',
  ])
  pending[0].resolve(request({ requestId: 'first' }))
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(3))
  pending[1].resolve(request({ requestId: 'second' }))
  pending[2].resolve(request({ requestId: 'third' }))
})

it('keeps same-request supplements ordered while another independent request can start', async () => {
  const { api, store } = await fixture()
  const first = deferred<AssistantExecutionRequest>()
  vi.mocked(api.submit).mockReturnValueOnce(first.promise)
  admit(store, 'A1', 'a')
  admit(store, 'A2', 'a')
  admit(store, 'Independent')
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.submit).mock.calls.map(call => call[2])).toEqual([
    expect.objectContaining({ action: 'followup', requestId: 'a', message: 'A1' }),
    expect.objectContaining({ action: 'new_request', message: 'Independent' }),
  ])
  first.resolve(request())
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(3))
  expect(vi.mocked(api.submit).mock.calls[2][2]).toMatchObject({
    action: 'followup',
    requestId: 'a',
    message: 'A2',
  })
})

it('retries the retained descriptor with its original key before later supplements', async () => {
  const { api, store } = await fixture()
  vi.mocked(api.submit).mockRejectedValueOnce(new Error('Acceptance unknown'))
  admit(store, 'First supplement', 'a')
  admit(store, 'Second supplement', 'a')
  await vi.waitFor(() => expect(store.getSnapshot().submissions[0].state).toBe('failed'))
  expect(api.submit).toHaveBeenCalledTimes(1)
  const failed = store.getSnapshot().submissions[0]
  store.retry(failed.clientId)
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(3))
  expect(vi.mocked(api.submit).mock.calls[0][2]).toEqual(vi.mocked(api.submit).mock.calls[1][2])
  expect(vi.mocked(api.submit).mock.calls[2][2].idempotencyKey).not.toBe(failed.idempotencyKey)
})

it('retains pending work across view detach, pauses unstarted transport, and isolates another account', async () => {
  const { api, store, detach } = await fixture()
  const pending = [deferred<AssistantExecutionRequest>(), deferred<AssistantExecutionRequest>()]
  vi.mocked(api.submit)
    .mockReturnValueOnce(pending[0].promise)
    .mockReturnValueOnce(pending[1].promise)
  for (const text of ['First', 'Second', 'Third']) admit(store, text)
  store.setMessage('Unsent private draft')
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2))
  const queuedKey = store.getSnapshot().submissions[2].idempotencyKey
  detach()
  const other = assistantRequestScopeStore({ ...scope, accountKey: 'backend-one:8', userId: 8 })
  const otherApi = {
    ...api,
    list: vi.fn().mockResolvedValue({ enabled: true, requests: [] }),
    submit: vi.fn(),
  }
  const detachOther = other.attach(otherApi)
  await other.refresh()
  pending[0].resolve(request())
  pending[1].resolve(request())
  await vi.waitFor(() => expect(store.getSnapshot().submissions[1].state).toBe('confirmed'))
  expect(api.submit).toHaveBeenCalledTimes(2)
  expect(other.getSnapshot().submissions).toEqual([])
  expect(other.draft().text).toBe('')
  expect(otherApi.submit).not.toHaveBeenCalled()
  detachOther()
  expect(assistantRequestScopeStore(scope)).toBe(store)
  const again = store.attach(api)
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(3))
  expect(vi.mocked(api.submit).mock.calls[2][2].idempotencyKey).toBe(queuedKey)
  expect(store.draft().text).toBe('Unsent private draft')
  again()
})

it('claims a descriptor once across two views of the same owner scope', async () => {
  const { api, store } = await fixture()
  const detach = store.attach(api)
  admit(store, 'Once')
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1))
  expect(assistantRequestScopeStore(scope)).toBe(store)
  detach()
})

it('keeps new and replacement admission closed until the capability is known and enabled', async () => {
  const api: AssistantRequestsApi = {
    list: vi.fn(),
    submit: vi.fn(),
    confirmMerge: vi.fn(),
  }
  const known = deferred<{ enabled: boolean; requests: AssistantExecutionRequest[] }>()
  vi.mocked(api.list).mockReturnValueOnce(known.promise)
  const store = assistantRequestScopeStore(scope)
  store.attach(api)
  store.openComposer({ action: 'new_request' })
  store.setMessage('Keep until known')
  expect(store.admit()).toBe(false)
  expect(store.draft().text).toBe('Keep until known')
  known.resolve({ enabled: false, requests: [request()] })
  await store.refresh()
  expect(store.admit()).toBe(false)
  store.openComposer({ action: 'replace', requestId: 'a' })
  store.setMessage('Replacement')
  expect(store.admit()).toBe(false)
  vi.mocked(api.submit).mockResolvedValue(request())
  admit(store, 'Allowed supplement', 'a')
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1))
})

it('admits with a known capability despite a stalled refresh, and never rolls back a confirmed mutation with an older read', async () => {
  const { api, store } = await fixture()
  const refresh = deferred<{ enabled: boolean; requests: AssistantExecutionRequest[] }>()
  vi.mocked(api.list).mockReturnValueOnce(refresh.promise)
  void store.refresh()
  vi.mocked(api.submit).mockResolvedValueOnce(request({ requestId: 'new', message: 'Newest' }))
  admit(store, 'Newest')
  await vi.waitFor(() => expect(store.getSnapshot().submissions[0].state).toBe('confirmed'))
  refresh.resolve({ enabled: true, requests: [request()] })
  await store.refresh()
  expect(store.getSnapshot().list?.requests[0].requestId).toBe('new')
  expect(store.getSnapshot().loading).toBe(false)
})

it('keeps failed reads explicit while allowing admission from the last successful capability', async () => {
  const { api, store } = await fixture()
  vi.mocked(api.list).mockRejectedValueOnce(new Error('offline'))
  await store.refresh()
  expect(store.getSnapshot().failed).toBe(true)
  admit(store, 'Still locally admitted')
  expect(store.getSnapshot().submissions[0].state).toBe('queued')
})

it('does not replace a newer running snapshot with a delayed acceptance response', async () => {
  const { api, store } = await fixture()
  const accepted = deferred<AssistantExecutionRequest>()
  vi.mocked(api.submit).mockReturnValueOnce(accepted.promise)
  admit(store, 'Independent B')
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1))
  const running = request({ requestId: 'b', state: 'running', updatedAt: '2026-11-18T00:00:02Z' })
  vi.mocked(api.list).mockResolvedValueOnce({ enabled: true, requests: [running] })
  await store.refresh()
  const pendingRead = deferred<{ enabled: boolean; requests: AssistantExecutionRequest[] }>()
  vi.mocked(api.list).mockReturnValueOnce(pendingRead.promise)
  accepted.resolve(
    request({ requestId: 'b', state: 'accepted', updatedAt: '2026-11-18T00:00:01Z' })
  )
  await vi.waitFor(() => expect(store.getSnapshot().submissions[0].state).toBe('confirmed'))
  expect(store.getSnapshot().list?.requests[0]).toEqual(running)
  pendingRead.resolve({ enabled: true, requests: [running] })
  await store.refresh()
})

it('does not display foreign mutation responses or reuse scope state for a different resource', async () => {
  const { api, store } = await fixture()
  vi.mocked(api.submit).mockResolvedValueOnce(
    request({ ownerUserId: 8, message: 'Foreign secret' })
  )
  admit(store, 'My message')
  await vi.waitFor(() => expect(store.getSnapshot().submissions[0].state).toBe('failed'))
  expect(JSON.stringify(store.getSnapshot())).not.toContain('Foreign secret')
  for (const change of [
    { accountKey: 'other' },
    { userId: 8 },
    { projectId: 'other' },
    { issueId: 'other' },
  ]) {
    const other = assistantRequestScopeStore({ ...scope, ...change })
    expect(other.getSnapshot().list).toBeNull()
    expect(other.getSnapshot().submissions).toEqual([])
  }
})

it('locks controls only for their request while allowing local supplement and independent admission', async () => {
  const { api, store } = await fixture()
  const cancel = deferred<AssistantExecutionRequest>()
  vi.mocked(api.submit).mockReturnValueOnce(cancel.promise)
  expect(store.submitControl({ action: 'cancel', requestId: 'a' })).toBe(true)
  expect(store.submitControl({ action: 'cancel', requestId: 'a' })).toBe(false)
  admit(store, 'After cancel', 'a')
  admit(store, 'Independent')
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.submit).mock.calls[1][2]).toMatchObject({ action: 'new_request' })
  cancel.resolve(request({ state: 'cancelled' }))
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(3))
})

it('cancels after an unconfirmed failed supplement without automatically resending it', async () => {
  const { api, store } = await fixture()
  vi.mocked(api.submit).mockRejectedValueOnce(new Error('Acceptance unknown'))
  admit(store, 'Unconfirmed supplement', 'a')
  await vi.waitFor(() => expect(store.getSnapshot().submissions[0].state).toBe('failed'))
  const failed = store.getSnapshot().submissions[0]
  expect(store.submitControl({ action: 'cancel', requestId: 'a' })).toBe(true)
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.submit).mock.calls[1][2]).toMatchObject({ action: 'cancel', requestId: 'a' })
  expect(store.getSnapshot().submissions[0]).toMatchObject({
    clientId: failed.clientId,
    idempotencyKey: failed.idempotencyKey,
    state: 'preserved',
  })
  expect(api.submit).toHaveBeenCalledTimes(2)
})

it('preserves in-flight and queued supplements when cancellation is admitted, including a late failure', async () => {
  const { api, store } = await fixture()
  const first = deferred<AssistantExecutionRequest>()
  vi.mocked(api.submit).mockReturnValueOnce(first.promise)
  admit(store, 'In-flight supplement', 'a')
  admit(store, 'Queued supplement', 'a')
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1))
  const original = store.getSnapshot().submissions.map(entry => entry.idempotencyKey)
  expect(store.submitControl({ action: 'cancel', requestId: 'a' })).toBe(true)
  expect(
    store
      .getSnapshot()
      .submissions.slice(0, 2)
      .map(entry => entry.state)
  ).toEqual(['preserved', 'preserved'])
  expect(api.submit).toHaveBeenCalledTimes(1)
  store.retry(store.getSnapshot().submissions[0].clientId)
  expect(store.getSnapshot().submissions[0].state).toBe('preserved')
  first.reject(new Error('Acceptance unknown'))
  await vi.waitFor(() => expect(store.getSnapshot().submissions[2].state).toBe('confirmed'))
  expect(vi.mocked(api.submit).mock.calls[1][2]).toMatchObject({ action: 'cancel', requestId: 'a' })
  expect(
    store
      .getSnapshot()
      .submissions.slice(0, 2)
      .map(entry => entry.state)
  ).toEqual(['preserved', 'preserved'])
  expect(
    store
      .getSnapshot()
      .submissions.slice(0, 2)
      .map(entry => entry.idempotencyKey)
  ).toEqual(original)
  expect(api.submit).toHaveBeenCalledTimes(2)
})

it('does not let an explicitly retried older message bypass a later cancellation control', async () => {
  const { api, store } = await fixture()
  const cancellation = deferred<AssistantExecutionRequest>()
  vi.mocked(api.submit)
    .mockRejectedValueOnce(new Error('Acceptance unknown'))
    .mockReturnValueOnce(cancellation.promise)
  admit(store, 'Older supplement', 'a')
  await vi.waitFor(() => expect(store.getSnapshot().submissions[0].state).toBe('failed'))
  const original = store.getSnapshot().submissions[0]
  expect(store.submitControl({ action: 'cancel', requestId: 'a' })).toBe(true)
  store.retry(original.clientId)
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.submit).mock.calls[1][2]).toMatchObject({ action: 'cancel' })
  expect(store.getSnapshot().submissions[0].state).toBe('queued')
  cancellation.resolve(request({ state: 'cancelled' }))
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(3))
  expect(vi.mocked(api.submit).mock.calls[2][2]).toMatchObject({
    action: 'followup',
    requestId: 'a',
    message: 'Older supplement',
    idempotencyKey: original.idempotencyKey,
  })
})

it('rechecks the owner transport lease after publishing a dispatch claim', async () => {
  const { api, store, detach } = await fixture()
  const unsubscribe = store.subscribe(() => {
    if (store.getSnapshot().submissions.some(entry => entry.state === 'sending')) detach()
  })
  admit(store, 'Still local')
  await vi.waitFor(() => expect(store.getSnapshot().submissions[0].state).toBe('queued'))
  await Promise.resolve()
  expect(api.submit).not.toHaveBeenCalled()
  unsubscribe()
  store.attach(api)
  await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1))
})
