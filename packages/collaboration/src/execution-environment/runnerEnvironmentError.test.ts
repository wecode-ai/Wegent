import { describe, expect, it } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { runnerEnvironmentError } from './runnerEnvironmentError'

describe('runnerEnvironmentError', () => {
  it.each([
    { errorCode: 'RUNNER_ENVIRONMENT_UNAVAILABLE' },
    { error_code: 'RUNNER_ENVIRONMENT_UNAVAILABLE' },
    { detail: { error_code: 'RUNNER_ENVIRONMENT_UNAVAILABLE' } },
  ])('explains the authorization denial in both hosts', error => {
    expect(runnerEnvironmentError(error, createCollaborationTranslator('zh-CN'))).toContain(
      '项目授权'
    )
    expect(runnerEnvironmentError(error, createCollaborationTranslator('en'))).toContain(
      'Project settings'
    )
  })

  it.each([
    null,
    new Error('Network failure'),
    { detail: { error_code: 'RUNNER_MODEL_REQUIRED' } },
  ])('leaves unrelated errors to their existing handlers', error => {
    expect(runnerEnvironmentError(error, createCollaborationTranslator('en'))).toBeNull()
  })
})
