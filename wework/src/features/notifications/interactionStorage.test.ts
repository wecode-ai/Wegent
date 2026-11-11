import { beforeEach, expect, it, vi } from 'vitest'
import {
  archiveInteraction,
  readInteractionDraftState,
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
  expect(readInteractionDraftState('drafts', 'history')).toEqual({ valid: 'keep this' })
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

it('restores recovery metadata independently of bounded history and upgrades existing string drafts', () => {
  const interaction = entry(1)
  const recovery = { text: 'Unsent text', interaction, nativeReplyIds: ['native-1'] }
  saveInteractionState('drafts', { [interaction.id]: recovery, pending: 'Still editable' })
  saveInteractionState(
    'history',
    Array.from({ length: 101 }, (_, i) => entry(i + 2))
  )
  expect(readInteractionHistory('history')).toHaveLength(100)
  expect(readInteractionDraftState('drafts', 'history')).toEqual({
    [interaction.id]: recovery,
    pending: 'Still editable',
  })
  saveInteractionState('drafts', { [interaction.id]: 'Older draft' })
  saveInteractionState('history', [interaction])
  expect(readInteractionDraftState('drafts', 'history')).toEqual({
    [interaction.id]: { text: 'Older draft', interaction, nativeReplyIds: [] },
  })
})

it('rejects malformed recovery records and metadata for a different interaction', () => {
  saveInteractionState('drafts', {
    mismatched: { text: 'Wrong owner', interaction: entry(1), nativeReplyIds: [] },
    invalid: { text: 'Missing metadata', nativeReplyIds: [] },
    receipts: { text: 'Invalid receipts', interaction: entry(1), nativeReplyIds: [42] },
  })
  expect(readInteractionDraftState('drafts', 'history')).toEqual({})
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

it('adds local dismissal without losing authoritative resolution or changing history order', () => {
  const resolved = {
    ...entry(1),
    id: resolution.nativeInteractionId,
    resolvedIssueQuestion: resolution,
  }
  const dismissed = archiveInteraction([resolved], { ...resolved, dismissed: true, answeredAt: 9 })
  expect(dismissed).toEqual([{ ...resolved, dismissed: true }])
  expect(archiveInteraction(dismissed, resolved)).toBe(dismissed)
  saveInteractionState('history', dismissed)
  expect(readInteractionHistory('history')).toEqual(dismissed)
})

it('validates the exact Issue identity of a local dismissal without granting resolution authority', () => {
  const dismissed = {
    ...entry(1),
    dismissed: true as const,
    dismissedQuestionIdentity: JSON.stringify([
      'backend',
      'project',
      'ISSUE-1',
      'review',
      'question',
    ]),
  }
  saveInteractionState('history', [dismissed])
  expect(readInteractionHistory('history')).toEqual([dismissed])
  expect(readInteractionHistory('history')[0].resolvedIssueQuestion).toBeUndefined()
  for (const invalid of [
    'not-json',
    JSON.stringify(['backend', 'project']),
    JSON.stringify(['other', 'project', 'ISSUE-1', 'review', 'question']),
  ]) {
    saveInteractionState('history', [{ ...dismissed, dismissedQuestionIdentity: invalid }])
    expect(readInteractionHistory('history')).toEqual([])
  }
})
