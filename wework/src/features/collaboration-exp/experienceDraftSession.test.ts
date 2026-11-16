import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ExperienceDraftSession } from './experienceDraftSession'
import { privateDraftPersistence } from './private/privateDraftPersistence'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

it('uses initial input only before the field has any persisted revision', () => {
  const persistence = privateDraftPersistence('account', 'scope')
  const initial = new ExperienceDraftSession(persistence, 'text', 'Unpersisted input')
  expect(initial.value).toBe('Unpersisted input')
  persistence.writeEntries({ 'revision:other': '1' })
  const independent = new ExperienceDraftSession(persistence, 'text', 'Independent input')
  expect(independent.value).toBe('Independent input')
})

it('restores an accepted clear instead of stale memory when completion happens between mounts', () => {
  const persistence = privateDraftPersistence('account', 'scope')
  const original = new ExperienceDraftSession(persistence, 'text', 'Accepted while away')
  const submission = original.retain(original.value)
  submission.clearIfUnchanged()
  submission.release()
  expect(persistence.read()).toEqual({ 'revision:text': '1' })
  const restored = new ExperienceDraftSession(persistence, 'text', 'Accepted while away')
  expect(restored.value).toBe('')
  expect(restored.revision).toBe(1)
})

it('restores the original request identity if persisting its accepted clear fails', () => {
  const persistence = privateDraftPersistence('account', 'scope')
  const original = new ExperienceDraftSession(persistence, 'text', '')
  original.update('Accepted but clear was not saved')
  const submission = original.retain(original.value)
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new Error('Storage unavailable')
  })
  submission.clearIfUnchanged()
  submission.release()
  expect(original.error).toBeInstanceOf(Error)
  write.mockRestore()
  const restored = new ExperienceDraftSession(persistence, 'text', '')
  expect(restored.value).toBe('Accepted but clear was not saved')
  const retry = restored.retain(restored.value)
  expect(retry.clientMessageId).toBe(submission.clientMessageId)
  retry.release()
})

it('restores the same explicit request identity and changes it after editing away and back', () => {
  const persistence = privateDraftPersistence('account', 'scope')
  const first = new ExperienceDraftSession(persistence, 'text', '')
  first.update('Original')
  const old = first.retain('Original')
  old.release()
  const restored = new ExperienceDraftSession(persistence, 'text', '')
  const retry = restored.retain('Original')
  expect(retry.clientMessageId).toBe(old.clientMessageId)
  restored.update('Changed')
  restored.update('Original')
  old.clearIfUnchanged()
  expect(persistence.read().text).toBe('Original')
  const newIntent = restored.retain('Original')
  expect(newIntent.clientMessageId).not.toBe(old.clientMessageId)
  retry.release()
  newIntent.release()
})

it('does not consume persisted edits made after the original retained revision', () => {
  const persistence = privateDraftPersistence('account', 'scope')
  const first = new ExperienceDraftSession(persistence, 'text', '')
  first.update('Original')
  const old = first.retain('Original')
  const replacement = new ExperienceDraftSession(persistence, 'text', '')
  replacement.update('New unsent draft')
  old.clearIfUnchanged()
  expect(persistence.read().text).toBe('New unsent draft')
  old.release()
})

it('allows explicit retry after transient storage failure without requiring another edit', () => {
  const persistence = privateDraftPersistence('account', 'scope')
  const session = new ExperienceDraftSession(persistence, 'text', '')
  session.update('Keep me')
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new Error('Storage unavailable')
  })
  expect(() => session.retain('Keep me')).toThrow('Storage unavailable')
  expect(session.value).toBe('Keep me')
  write.mockRestore()
  const retry = session.retain('Keep me')
  expect(retry.clientMessageId).toEqual(expect.any(String))
  expect(session.error).toBeNull()
  retry.release()
})

it('rereads and validates the persisted original intent when a transient restore failure recovers', () => {
  const persistence = privateDraftPersistence('account', 'scope')
  const original = new ExperienceDraftSession(persistence, 'text', '')
  original.update('Keep original intent')
  const prior = original.retain('Keep original intent')
  prior.release()
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
    throw new Error('Storage temporarily unavailable')
  })
  const restored = new ExperienceDraftSession(persistence, 'text', 'Keep original intent')
  expect(restored.error).toBeInstanceOf(Error)
  read.mockRestore()
  const retry = restored.retain('Keep original intent')
  expect(retry.clientMessageId).toBe(prior.clientMessageId)
  expect(restored.error).toBeNull()
  retry.release()
})

it('rejects a restored intent for different text until an explicit edit creates a new intent', () => {
  const persistence = privateDraftPersistence('account', 'scope')
  persistence.writeEntries({
    text: 'Current',
    'revision:text': '1',
    'publication:text': JSON.stringify({
      clientMessageId: 'old-native-id',
      body: 'Other',
      revision: 1,
    }),
  })
  const session = new ExperienceDraftSession(persistence, 'text', '')
  expect(() => session.retain('Current')).toThrow('Invalid draft publication intent')
  expect(persistence.read().text).toBe('Current')
  session.update('Explicit new edit')
  const submission = session.retain('Explicit new edit')
  expect(submission.clientMessageId).not.toBe('old-native-id')
  submission.release()
})
