import { describe, expect, test } from 'vitest'
import {
  buildLocalHarnessLaunchArgs,
  isMeaningfulLocalHarnessTitle,
  localHarnessPluginRootFromSkillPath,
  normalizeLocalHarnessPreferences,
  parseLocalHarnessArgs,
  parseLocalHarnessEnv,
} from './local-harness'

describe('local harness settings', () => {
  test('distinguishes generated task titles from generic Harness titles', () => {
    expect(isMeaningfulLocalHarnessTitle('opencode', 'OpenCode')).toBe(false)
    expect(isMeaningfulLocalHarnessTitle('claude_code', 'Claude Code')).toBe(false)
    expect(isMeaningfulLocalHarnessTitle('kimi_code', 'Kimi')).toBe(false)
    expect(isMeaningfulLocalHarnessTitle('opencode', 'Inspect available plugins')).toBe(true)
  })

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
      {
        id: 'kimi_code',
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

  test('replaces configured model arguments with the Wework Kimi model alias', () => {
    expect(
      buildLocalHarnessLaunchArgs(
        {
          id: 'kimi_code',
          enabled: true,
          executablePath: null,
          args: ['-m', 'old-model', '--verbose'],
          env: {},
          permissionMode: 'default',
        },
        '__kimi_env_model__'
      )
    ).toEqual(['--verbose', '--model', '__kimi_env_model__'])
  })

  test('derives the shared Agent Plugin root from an installed skill path', () => {
    expect(
      localHarnessPluginRootFromSkillPath(
        '/Users/me/.wework/plugins/cache/marketplace/github/1.0.0/skills/review/SKILL.md'
      )
    ).toBe('/Users/me/.wework/plugins/cache/marketplace/github/1.0.0')
    expect(
      localHarnessPluginRootFromSkillPath(
        'C:\\Users\\me\\.wework\\plugins\\demo\\skills\\review\\SKILL.md'
      )
    ).toBe('C:/Users/me/.wework/plugins/demo')
    expect(localHarnessPluginRootFromSkillPath('/Users/me/.agents/skills/review/SKILL.md')).toBe(
      '/Users/me/.agents'
    )
    expect(localHarnessPluginRootFromSkillPath('/Users/me/review/SKILL.md')).toBeNull()
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
