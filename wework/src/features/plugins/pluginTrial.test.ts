import { beforeEach, describe, expect, test } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import {
  consumePluginTrial,
  consumePluginTrialInput,
  pluginTrialInput,
  queuePluginTrial,
} from './pluginTrial'

function pluginWithSkill(
  path = '/Users/test/.codex/plugins/cache/wework-local/docs/1/skills/docs/SKILL.md'
) {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { namespace: 'OpenAI Bundled', labels: { id: 'docs' } },
    spec: {
      source: {
        type: 'local',
        providerKey: 'codex-local',
        pluginKey: 'documents',
      },
      displayName: 'Documents',
      description: 'Create documents',
      installState: 'installed',
      enabled: true,
      manifest: {},
      components: {
        skills: [{ name: 'documents', path }],
        commands: [
          {
            name: 'Project Memo',
            path: 'project_memo',
            description: 'Draft a project memo',
            logoUrl: 'https://example.com/memo.png',
          },
        ],
        templates: [
          {
            name: 'Project Memo',
            path: 'project_memo',
            description: 'Draft a project memo',
            logoUrl: 'https://example.com/memo.png',
          },
        ],
        agents: [],
        hooks: [],
        mcps: [],
        lsps: [],
        monitors: [],
        bins: [],
      },
      interface: null,
      packageRef: null,
      sourcePayload: {
        pluginName: 'documents',
        marketplaceName: 'OpenAI Bundled',
      },
    },
    status: { state: 'enabled' },
  } satisfies InstalledPlugin
}

function pluginWithDefaultPrompt(defaultPrompt: string[] | string): InstalledPlugin {
  return {
    ...pluginWithSkill('/tmp/plugin/skills/report/SKILL.md'),
    spec: {
      ...pluginWithSkill('/tmp/plugin/skills/report/SKILL.md').spec,
      interface: {
        defaultPrompt,
      },
    },
  } as InstalledPlugin
}

describe('plugin trial state', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  test('builds a local skill mention from the first plugin skill', () => {
    expect(pluginTrialInput(pluginWithSkill())).toBe(
      '[$Documents](plugin://documents@OpenAI Bundled) '
    )
  })

  test('normalizes plugin skill directory paths to SKILL.md file paths', () => {
    expect(pluginTrialInput(pluginWithSkill('/tmp/plugin/skills/report'))).toBe(
      '[$Documents](plugin://documents@OpenAI Bundled) '
    )
  })

  test('uses plugin default prompt and replaces the skill token', () => {
    expect(pluginTrialInput(pluginWithDefaultPrompt(['Use $documents to draft a report.']))).toBe(
      'Use [$Documents](plugin://documents@OpenAI Bundled) to draft a report. '
    )
  })

  test('prefixes the skill mention when default prompt omits the skill token', () => {
    expect(pluginTrialInput(pluginWithDefaultPrompt('Draft a report.'))).toBe(
      '[$Documents](plugin://documents@OpenAI Bundled) Draft a report.'
    )
  })

  test('queues and consumes plugin trial input once', () => {
    expect(queuePluginTrial(pluginWithSkill('/tmp/plugin/skills/report/SKILL.md'))).toBe(true)
    expect(consumePluginTrialInput()).toBe('[$Documents](plugin://documents@OpenAI Bundled) ')
    expect(consumePluginTrialInput()).toBeNull()
  })

  test('queues plugin templates for the trial composer', () => {
    expect(queuePluginTrial(pluginWithSkill('/tmp/plugin/skills/report/SKILL.md'))).toBe(true)
    expect(consumePluginTrial()?.templates).toEqual([
      {
        name: 'Project Memo',
        path: 'project_memo',
        description: 'Draft a project memo',
        logoUrl: 'https://example.com/memo.png',
      },
    ])
  })
})
