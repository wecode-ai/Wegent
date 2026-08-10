import { describe, expect, test } from 'vitest'
import {
  buildLocalHarnessLaunchArgs,
  normalizeLocalHarnessPreferences,
  parseLocalHarnessArgs,
  parseLocalHarnessEnv,
} from './local-harness'

describe('local harness settings', () => {
  test('restores missing harness defaults while preserving valid overrides', () => {
    const preferences = normalizeLocalHarnessPreferences([
      {
        id: 'opencode',
        enabled: false,
        executablePath: ' /custom/opencode ',
        args: ['--model', 'openai/gpt-5'],
        env: { OPENCODE_CONFIG: '/tmp/opencode.json' },
        permissionMode: 'bypass',
        modelKey: '  wework:runtime::local-model  ',
      },
    ])

    expect(preferences).toEqual([
      {
        id: 'opencode',
        enabled: false,
        executablePath: '/custom/opencode',
        args: ['--model', 'openai/gpt-5'],
        env: { OPENCODE_CONFIG: '/tmp/opencode.json' },
        permissionMode: 'default',
        modelKey: 'wework:runtime::local-model',
      },
      {
        id: 'claude_code',
        enabled: true,
        executablePath: null,
        args: [],
        env: {},
        permissionMode: 'default',
      },
    ])
  })

  test('adds Claude Code permission arguments before custom arguments', () => {
    expect(
      buildLocalHarnessLaunchArgs(
        {
          id: 'claude_code',
          enabled: true,
          executablePath: null,
          args: ['--model', 'opus'],
          env: {},
          permissionMode: 'plan',
        },
        'sonnet'
      )
    ).toEqual(['--permission-mode', 'plan', '--model', 'sonnet'])
  })

  test('replaces configured model arguments with the selected OpenCode model', () => {
    expect(
      buildLocalHarnessLaunchArgs(
        {
          id: 'opencode',
          enabled: true,
          executablePath: null,
          args: ['--model=old/model', '--verbose'],
          env: {},
          permissionMode: 'default',
        },
        'openai/gpt-5.2'
      )
    ).toEqual(['--verbose', '--model', 'openai/gpt-5.2'])
  })

  test('parses arguments and environment without shell evaluation', () => {
    expect(parseLocalHarnessArgs("--model\n'quoted value'\n\n--verbose")).toEqual([
      '--model',
      "'quoted value'",
      '--verbose',
    ])
    expect(parseLocalHarnessEnv('API_URL=https://example.test?a=b\nEMPTY=')).toEqual({
      env: {
        API_URL: 'https://example.test?a=b',
        EMPTY: '',
      },
      error: null,
    })
  })

  test('reports the invalid environment line', () => {
    expect(parseLocalHarnessEnv('VALID=1\nINVALID')).toEqual({
      env: {},
      error: 'line:2',
    })
  })
})
