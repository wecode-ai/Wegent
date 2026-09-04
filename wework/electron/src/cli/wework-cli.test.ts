import { describe, expect, test } from 'vitest'
import { parseCliArgs, smartAppRequest, summarizeSmartAppResult } from './wework-cli.mjs'

describe('wework smart-app CLI', () => {
  test('parses fixed inspect, verify, and pack requests for an absolute linked project root', () => {
    expect(smartAppRequest('inspect', { project: '/workspace/smart-app', format: 'json' })).toEqual(
      { action: 'inspect', projectRoot: '/workspace/smart-app', format: 'json' }
    )
    expect(smartAppRequest('verify', { project: '/workspace/smart-app' })).toEqual({
      action: 'verify',
      projectRoot: '/workspace/smart-app',
      format: 'human',
    })
    expect(
      smartAppRequest('pack', {
        project: '/workspace/smart-app',
        output: '/workspace/release.zip',
        instance: 'main',
        format: 'json',
      })
    ).toEqual({
      action: 'pack',
      projectRoot: '/workspace/smart-app',
      outputPath: '/workspace/release.zip',
      format: 'json',
    })
  })

  test('rejects relative roots and arbitrary command-style arguments', () => {
    expect(() => smartAppRequest('verify', { project: 'relative/app' })).toThrow(
      '--project must be an absolute path'
    )
    expect(() => smartAppRequest('pack', { project: '/workspace/app' })).toThrow(
      '--output is required for smart-app pack'
    )
    expect(() => smartAppRequest('run', { project: '/workspace/app' })).toThrow(
      'Unknown smart-app command'
    )
    expect(() => smartAppRequest('verify', { project: '/workspace/app', argv: 'node' })).toThrow(
      'Unknown smart-app option'
    )
  })

  test('parses generic CLI options without exposing desktop tokens in human summaries', () => {
    expect(parseCliArgs(['smart-app', 'verify', '--project', '/workspace/app'])).toEqual({
      namespace: 'smart-app',
      command: 'verify',
      options: { project: '/workspace/app' },
    })
    expect(
      summarizeSmartAppResult({
        status: 'failed',
        stages: [{ stage: 'runtime', status: 'failed' }],
        issues: [{ code: 'SA-RUNTIME-START', file: null }],
        token: 'must-not-leak',
      })
    ).toBe('Smart App verification: failed\nRuntime: failed\nSA-RUNTIME-START')
  })
})
