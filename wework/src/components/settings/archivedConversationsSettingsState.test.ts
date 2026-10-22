import { beforeEach, expect, test } from 'vitest'
import {
  beginArchivedCleanup,
  getArchivedCleanupError,
  hasArchivedBulkDeletedKey,
  notifyArchivedBulkDeleteDeleted,
  reportArchivedCleanupFailure,
  resetArchivedConversationsSettingsStateForTest,
} from './archivedConversationsSettingsState'

beforeEach(resetArchivedConversationsSettingsStateForTest)

test('a late accepted response cannot hide a failed background deletion', () => {
  reportArchivedCleanupFailure('task-1', 'Git metadata missing')
  notifyArchivedBulkDeleteDeleted(new Set(['task-1', 'task-2']))
  expect(hasArchivedBulkDeletedKey('task-1')).toBe(false)
  expect(hasArchivedBulkDeletedKey('task-2')).toBe(true)
  expect(getArchivedCleanupError()).toBe('Git metadata missing')
})

test('an explicit retry clears only its own failure', () => {
  reportArchivedCleanupFailure('task-1', 'First failure')
  reportArchivedCleanupFailure('task-2', 'Second failure')
  beginArchivedCleanup(['task-1'])
  notifyArchivedBulkDeleteDeleted(new Set(['task-1']))
  expect(hasArchivedBulkDeletedKey('task-1')).toBe(true)
  expect(getArchivedCleanupError()).toBe('Second failure')
  beginArchivedCleanup(['task-2'])
  expect(getArchivedCleanupError()).toBeNull()
})
