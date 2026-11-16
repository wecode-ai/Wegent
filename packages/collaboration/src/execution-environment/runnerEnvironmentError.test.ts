import { describe, expect, it } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { runnerEnvironmentError } from './runnerEnvironmentError'

describe('runnerEnvironmentError', () => {
  it.each([
    { errorCode: 'RUNNER_ENVIRONMENT_UNAVAILABLE' },
    { error_code: 'RUNNER_ENVIRONMENT_UNAVAILABLE' },
    { detail: { error_code: 'RUNNER_ENVIRONMENT_UNAVAILABLE' } },
  ])('explains the authorization denial in both hosts', (error) => {
    expect(
      runnerEnvironmentError(error, createCollaborationTranslator('zh-CN')),
    ).toContain('项目授权')
    expect(
      runnerEnvironmentError(error, createCollaborationTranslator('en')),
    ).toContain('Project settings')
  })

  it.each([
    null,
    new Error('Network failure'),
    { detail: { error_code: 'RUNNER_MODEL_REQUIRED' } },
  ])('leaves unrelated errors to their existing handlers', (error) => {
    expect(
      runnerEnvironmentError(error, createCollaborationTranslator('en')),
    ).toBeNull()
  })

  it('identifies the failing group member, bound device and policy device in both languages', () => {
    const error = {
      detail: {
        error_code: 'ISSUE_RUNNER_CONFLICT',
        routing_context: {
          group_name: 'Development group',
          agent_name: 'Reviewer',
          reason: 'policy_mismatch',
          bound_environment: { id: '1', name: 'Original runner' },
          policy_environment: { id: '2', name: 'Other runner' },
        },
      },
    }
    for (const locale of ['zh-CN', 'en'] as const) {
      const message = runnerEnvironmentError(
        error,
        createCollaborationTranslator(locale),
      )!
      for (const value of [
        'Development group',
        'Reviewer',
        'Original runner (1)',
        'Other runner (2)',
        'ISSUE_RUNNER_CONFLICT',
      ])
        expect(message).toContain(value)
    }
  })

  it('explains a conflict from an older backend without diagnostics', () => {
    expect(
      runnerEnvironmentError(
        { errorCode: 'ISSUE_RUNNER_CONFLICT' },
        createCollaborationTranslator('zh-CN'),
      ),
    ).toContain('项目设置')
  })
})
