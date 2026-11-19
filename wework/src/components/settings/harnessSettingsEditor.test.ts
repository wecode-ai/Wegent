import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { createHarnessSettingsEditor } from './harnessSettingsEditor'
const save = vi.hoisted(() => vi.fn())
vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  updateAppPreferences: save,
}))
const cleanups: Array<() => void> = []
function editor() {
  const value = createHarnessSettingsEditor(defaultAppPreferences.localHarnesses)
  cleanups.push(value.subscribe(() => {}, defaultAppPreferences.localHarnesses))
  return value
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.useFakeTimers()
  save.mockReset().mockImplementation(async patch => ({ ...defaultAppPreferences, ...patch }))
})
afterEach(() => {
  cleanups.splice(0).forEach(stop => stop())
  vi.useRealTimers()
})

test('debounces edits and parses only the final arguments and environment', async () => {
  const value = editor()
  value.updateDraft('claude_code', draft => ({ ...draft, argsText: '--verbose' }))
  await vi.advanceTimersByTimeAsync(200)
  value.updateDraft('claude_code', draft => ({ ...draft, envText: 'REGION=west' }))
  await vi.advanceTimersByTimeAsync(399)
  expect(save).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0][0].localHarnesses).toContainEqual(
    expect.objectContaining({ id: 'claude_code', args: ['--verbose'], env: { REGION: 'west' } })
  )
  expect(value.getSnapshot().status.kind).toBe('saved')
  expect(value.getSnapshot().dirty).toBe(false)
})

test('stops failed autosaves until an explicit retry or a new edit', async () => {
  save.mockRejectedValueOnce(new Error('Write failed'))
  const value = editor()
  value.updateDraft('claude_code', draft => ({ ...draft, argsText: '--keep-draft' }))
  await vi.advanceTimersByTimeAsync(400)
  expect(value.getSnapshot().status.kind).toBe('failed')
  expect(value.getSnapshot().drafts.claude_code.argsText).toBe('--keep-draft')
  await vi.advanceTimersByTimeAsync(4000)
  expect(save).toHaveBeenCalledTimes(1)
  value.retry()
  await vi.advanceTimersByTimeAsync(0)
  expect(save).toHaveBeenCalledTimes(2)
  expect(value.getSnapshot().status.kind).toBe('saved')
})

test('requires correcting invalid environment lines and never sends them to persistence', async () => {
  const value = editor()
  value.updateDraft('claude_code', draft => ({ ...draft, envText: 'INVALID LINE' }))
  await vi.advanceTimersByTimeAsync(400)
  expect(value.getSnapshot().status).toEqual({ kind: 'invalid', id: 'claude_code', line: '1' })
  expect(save).not.toHaveBeenCalled()
  value.retry()
  await vi.advanceTimersByTimeAsync(4000)
  expect(save).not.toHaveBeenCalled()
  value.updateDraft('claude_code', draft => ({ ...draft, envText: 'REGION=west' }))
  await vi.advanceTimersByTimeAsync(400)
  expect(save).toHaveBeenCalledTimes(1)
})

test('retains edits made during an accepted write and serializes the next save', async () => {
  const pending = deferred<typeof defaultAppPreferences>()
  save.mockReturnValueOnce(pending.promise)
  const value = editor()
  value.updateDraft('claude_code', draft => ({ ...draft, argsText: '--first' }))
  await vi.advanceTimersByTimeAsync(400)
  value.updateDraft('claude_code', draft => ({ ...draft, argsText: '--latest' }))
  await vi.advanceTimersByTimeAsync(1000)
  expect(save).toHaveBeenCalledTimes(1)
  pending.resolve({
    ...defaultAppPreferences,
    localHarnesses: save.mock.calls[0][0].localHarnesses,
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(value.getSnapshot().drafts.claude_code.argsText).toBe('--latest')
  expect(save).toHaveBeenCalledTimes(2)
  expect(save.mock.calls[1][0].localHarnesses).toContainEqual(
    expect.objectContaining({ id: 'claude_code', args: ['--latest'] })
  )
})

test('does not postpone the autosave when an unrelated preference subscription changes', async () => {
  const value = createHarnessSettingsEditor(defaultAppPreferences.localHarnesses)
  let stop = value.subscribe(() => {}, defaultAppPreferences.localHarnesses)
  value.updateDraft('claude_code', draft => ({ ...draft, argsText: '--draft' }))
  await vi.advanceTimersByTimeAsync(200)
  stop()
  stop = value.subscribe(() => {}, [...defaultAppPreferences.localHarnesses])
  cleanups.push(stop)
  await vi.advanceTimersByTimeAsync(200)
  expect(save).toHaveBeenCalledTimes(1)
})

test('does not replace a dirty draft with preferences published elsewhere', async () => {
  const value = editor()
  value.updateDraft('claude_code', draft => ({ ...draft, argsText: '--unsaved' }))
  cleanups.push(
    value.subscribe(
      () => {},
      defaultAppPreferences.localHarnesses.map(preference => ({
        ...preference,
        args: ['--external'],
      }))
    )
  )
  expect(value.getSnapshot().drafts.claude_code.argsText).toBe('--unsaved')
  await vi.advanceTimersByTimeAsync(400)
  expect(save.mock.calls[0][0].localHarnesses).toContainEqual(
    expect.objectContaining({ id: 'claude_code', args: ['--unsaved'] })
  )
})

test('adopts external preferences when clean without writing them back', async () => {
  const value = editor()
  cleanups.push(
    value.subscribe(
      () => {},
      defaultAppPreferences.localHarnesses.map(preference => ({
        ...preference,
        args: ['--external'],
      }))
    )
  )
  expect(value.getSnapshot().drafts.claude_code.argsText).toBe('--external')
  await vi.advanceTimersByTimeAsync(400)
  expect(save).not.toHaveBeenCalled()
})

test('finishes an accepted write after detach without scheduling newer unsent drafts', async () => {
  const pending = deferred<typeof defaultAppPreferences>()
  save.mockReturnValueOnce(pending.promise)
  const value = editor()
  value.updateDraft('claude_code', draft => ({ ...draft, argsText: '--accepted' }))
  await vi.advanceTimersByTimeAsync(400)
  value.updateDraft('claude_code', draft => ({ ...draft, argsText: '--unsent' }))
  cleanups.splice(0).forEach(stop => stop())
  pending.resolve({
    ...defaultAppPreferences,
    localHarnesses: save.mock.calls[0][0].localHarnesses,
  })
  await vi.advanceTimersByTimeAsync(4000)
  expect(save).toHaveBeenCalledTimes(1)
})

test('cancels a pending debounce when the last editor closes', async () => {
  const value = editor()
  value.updateDraft('claude_code', draft => ({ ...draft, argsText: '--unsent' }))
  cleanups.splice(0).forEach(stop => stop())
  await vi.advanceTimersByTimeAsync(400)
  expect(save).not.toHaveBeenCalled()
})
