import { expect, test } from 'vitest'
import { gitCloneFailureReason, isGitCloneDeviceMissing } from './gitCloneProjectRecovery'

test('recognizes a missing device in a retained failure', () => {
  expect(
    isGitCloneDeviceMissing({
      failureReason: 'clone-failed',
      error: 'executor-not-found:removed-device',
    })
  ).toBe(true)
})

test('ordinary Git output cannot redirect recovery to another device', () => {
  expect(gitCloneFailureReason(new Error('fatal: executor-not-found:repository'), 'clone')).toBe(
    'clone-failed'
  )
})

test('offline device retry retains its refresh path', () => {
  expect(gitCloneFailureReason(new Error('executor-offline:device'), 'clone')).toBe(
    'executor-offline'
  )
})

test('ordinary workspace opening failures retain the open-only retry path', () => {
  expect(gitCloneFailureReason(new Error('Could not register the workspace'), 'open')).toBe(
    'open-failed'
  )
})
