import { expect, test } from 'vitest'
import { gitCloneFailureReason, isGitCloneDeviceMissing } from './gitCloneProjectRecovery'

test('recognizes a missing device in an already retained legacy failure', () => {
  expect(
    isGitCloneDeviceMissing({
      id: 'pending-clone',
      deviceId: 'removed-device',
      name: 'repo',
      url: 'https://git.example/repo.git',
      targetPath: '/workspace/repo',
      status: 'failed',
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
