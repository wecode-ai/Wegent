// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  getConversationDiagnosticsSnapshot,
  resetConversationDiagnosticsForTest,
  startConversationDiagnosticCapture,
} from '@wegent/collaboration/conversation/conversationDiagnostics'
import {
  createMatchHydrationResource,
  createTranscriptSearchResource,
} from './conversationSearchResources'

beforeEach(() => {
  resetConversationDiagnosticsForTest()
  startConversationDiagnosticCapture()
})
afterEach(() => resetConversationDiagnosticsForTest())
const events = () => getConversationDiagnosticsSnapshot()!.events
function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test('records actual transcript request admission and completion without query text or owner identity', async () => {
  const request = vi.fn().mockResolvedValue({ matches: [], totalMatches: 0, isCapped: false })
  const resource = createTranscriptSearchResource('Private-owner', 'Private-query', request)!
  const stop = resource.subscribe(vi.fn())
  await vi.waitFor(() => expect(resource.getSnapshot().status).toBe('ready'))
  stop()
  expect(events().map(event => event.name)).toEqual([
    'search-transcript-request',
    'search-transcript-request',
  ])
  expect(events().map(event => event.details.phase)).toEqual([0, 1])
  expect(events()[0].details.queryLength).toBe('Private-query'.length)
  expect(JSON.stringify(events())).not.toContain('Private')
  expect(
    events().every(event => Object.values(event.details).every(value => typeof value !== 'string'))
  ).toBe(true)
})

test('a failed hydration records a failure without private error or match data', async () => {
  const resource = createMatchHydrationResource(
    'Private-owner',
    {
      itemId: 'Private-item',
      cursor: 'Private-cursor',
      occurrence: 0,
    },
    vi.fn().mockRejectedValue(new Error('Private-error'))
  )
  const stop = resource.subscribe(vi.fn())
  await vi.waitFor(() => expect(resource.getSnapshot().status).toBe('error'))
  stop()
  expect(events().map(event => event.name)).toEqual([
    'search-hydration-request',
    'search-hydration-request',
  ])
  expect(events().map(event => event.details.phase)).toEqual([0, 2])
  expect(events().at(-1)?.details.historyFailed).toBe(true)
  expect(JSON.stringify(events())).not.toContain('Private')
})

test('cancelled hydration emits one cancellation and ignores its late completion', async () => {
  const pending = held<void>()
  const resource = createMatchHydrationResource(
    'a',
    { itemId: 'item', occurrence: 0, cursor: 'cursor' },
    () => pending.promise
  )
  const stop = resource.subscribe(vi.fn())
  stop()
  pending.resolve()
  await pending.promise
  await Promise.resolve()
  expect(events().map(event => event.details.phase)).toEqual([0, 3])
  expect(resource.getSnapshot().status).toBe('idle')
})
