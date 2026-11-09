import { beforeEach, expect, it, vi } from 'vitest'
import {
  archiveInteraction,
  readInteractionDrafts,
  readInteractionHistory,
  saveInteractionState,
} from './interactionStorage'
import type { InteractionHistory } from './RuntimeInteractionsContext'
import { pendingInteractionCache, readPendingInteractionCache } from './interactionStorage'
import {
  canReplyToInteraction,
  interactionOriginalScheme,
  readRuntimeInteractions,
} from './runtimeInteractions'
import { interactionTask, interactionTranscript } from './runtimeInteractions.fixtures'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

const entry = (index: number): InteractionHistory => ({
  id: String(index),
  title: 'Review',
  question: 'Which behavior?',
  address: { deviceId: 'device', taskId: 'review' },
  answeredAt: index,
})

beforeEach(() => localStorage.clear())

const resolution = {
  questionIdentity: JSON.stringify(['backend', 'project', 'ISSUE-1', 'review', 'question']),
  nativeInteractionId: JSON.stringify(['device', 'review', 'item:question']),
}

it('persists only complete internally consistent canonical resolution identities', () => {
  const resolved = {
    ...entry(1),
    id: resolution.nativeInteractionId,
    resolvedIssueQuestion: resolution,
  }
  saveInteractionState('history', [resolved])
  expect(readInteractionHistory('history')).toEqual([resolved])
  for (const invalid of [
    {},
    { ...resolution, questionIdentity: 'broken JSON' },
    { ...resolution, nativeInteractionId: 'different' },
    {
      ...resolution,
      questionIdentity: JSON.stringify(['backend', 'project', 'ISSUE-1', 'other-task', 'question']),
    },
  ]) {
    saveInteractionState('history', [{ ...resolved, resolvedIssueQuestion: invalid }])
    expect(readInteractionHistory('history')).toEqual([])
  }
})

it('upgrades an existing history row with validated resolution without duplicating or rewriting it', () => {
  const ordinary = { ...entry(1), id: resolution.nativeInteractionId }
  const upgraded = archiveInteraction([ordinary], {
    ...ordinary,
    answeredAt: 5,
    resolvedIssueQuestion: resolution,
  })
  expect(upgraded).toEqual([{ ...ordinary, resolvedIssueQuestion: resolution }])
  expect(archiveInteraction(upgraded, { ...ordinary, resolvedIssueQuestion: resolution })).toBe(
    upgraded
  )
  expect(archiveInteraction(upgraded, ordinary)).toBe(upgraded)
})

it('retains source grouping across offline cache and handled-history reloads', async () => {
  const [item] = await readRuntimeInteractions(interactionTask, {
    getRuntimeTranscript: vi.fn().mockResolvedValue(interactionTranscript()),
  } as unknown as NonNullable<WorkbenchServices['runtimeWorkApi']>)
  item.source = 'stand_in'
  saveInteractionState('pending', pendingInteractionCache([item]))
  expect(readPendingInteractionCache('pending')[0].source).toBe('stand_in')
  saveInteractionState('history', [{ ...entry(1), source: item.source }])
  expect(readInteractionHistory('history')[0].source).toBe('stand_in')
})

it('keeps native source message locators in the offline cache and handled history', async () => {
  const [item] = await readRuntimeInteractions(interactionTask, {
    getRuntimeTranscript: vi.fn().mockResolvedValue(interactionTranscript()),
  } as unknown as NonNullable<WorkbenchServices['runtimeWorkApi']>)
  item.sourceMessageIds = ['original-comment']
  saveInteractionState('pending', pendingInteractionCache([item]))
  expect(readPendingInteractionCache('pending')[0].sourceMessageIds).toEqual(['original-comment'])
  saveInteractionState('history', [{ ...entry(1), sourceMessageIds: item.sourceMessageIds }])
  expect(readInteractionHistory('history')[0].sourceMessageIds).toEqual(['original-comment'])
  saveInteractionState('history', [{ ...entry(1), sourceMessageIds: [42] }])
  expect(readInteractionHistory('history')).toEqual([])
})

it('restores only last-known display metadata, never cached answers or runtime credentials', async () => {
  const task = {
    ...interactionTask,
    task: { ...interactionTask.task, runtimeHandle: { privateCredential: 'must-not-persist' } },
  }
  const [item] = await readRuntimeInteractions(task, {
    getRuntimeTranscript: vi.fn().mockResolvedValue(interactionTranscript()),
  } as unknown as NonNullable<WorkbenchServices['runtimeWorkApi']>)
  saveInteractionState('pending', pendingInteractionCache([item]))
  expect(localStorage.getItem('pending')).not.toContain('must-not-persist')
  const [restored] = readPendingInteractionCache('pending')
  expect(restored.id).toBe(item.id)
  expect(restored.cached).toBe(true)
  expect(restored.question).toBe(item.question)
  expect(canReplyToInteraction(restored)).toBe(false)
  expect(interactionOriginalScheme(restored)).toBe(interactionOriginalScheme(item))
})

it('rejects malformed persisted history and drafts without breaking the inbox', () => {
  localStorage.setItem('history', JSON.stringify([entry(1), null, { id: 'invalid' }]))
  localStorage.setItem('drafts', JSON.stringify({ valid: 'keep this', invalid: {}, null: null }))
  expect(readInteractionHistory('history')).toEqual([entry(1)])
  expect(readInteractionDrafts('drafts')).toEqual({ valid: 'keep this' })
  localStorage.setItem('history', '{}')
  expect(readInteractionHistory('history')).toEqual([])
})

it('keeps the newest 100 responses stable when old transcripts are repeatedly refreshed', () => {
  const current = Array.from({ length: 100 }, (_, i) => entry(101 - i))
  expect(archiveInteraction(current, entry(1))).toBe(current)
  expect(archiveInteraction(current, entry(40))).toBe(current)
  const next = archiveInteraction(current, entry(102))
  expect(next).toHaveLength(100)
  expect(next[0].id).toBe('102')
  expect(next.at(-1)?.id).toBe('3')
})

it('keeps a storage quota failure from changing the accepted response outcome', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Quota exceeded')
  })
  let saved: boolean | undefined
  expect(() => {
    saved = saveInteractionState('history', [entry(1)])
  }).not.toThrow()
  expect(saved).toBe(false)
  expect(log).toHaveBeenCalledOnce()
  write.mockRestore()
  log.mockRestore()
})

it('acknowledges a successful synchronous storage update', () => {
  expect(saveInteractionState('history', [entry(1)])).toBe(true)
  expect(readInteractionHistory('history')).toEqual([entry(1)])
})
