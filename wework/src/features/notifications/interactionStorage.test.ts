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
  expect(() => saveInteractionState('history', [entry(1)])).not.toThrow()
  expect(log).toHaveBeenCalledOnce()
  write.mockRestore()
  log.mockRestore()
})
