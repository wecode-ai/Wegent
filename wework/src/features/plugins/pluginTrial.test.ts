import { beforeEach, describe, expect, test } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import {
  buildContextualPluginPrompt,
  buildRefinedPluginPrompt,
  buildTrialTemplatePrompt,
  consumePluginTrial,
  consumePluginTrialInput,
  dismissTrialGuide,
  getPluginUseCount30d,
  pluginTrialInput,
  pluginTrialTemplates,
  queuePluginPromptTrial,
  queuePluginReferenceTrial,
  queuePluginTrial,
  recordPluginUsage,
  recordPluginUsageFromInput,
  shouldShowPluginTrialGuide,
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

  test('uses an explicit prompt when the caller selects an application type', () => {
    const plugin = pluginWithDefaultPrompt('Build an internal website.')

    expect(pluginTrialInput(plugin, { prompt: '创建并发布一个小程序' })).toBe(
      '[$Documents](plugin://documents@OpenAI Bundled) 创建并发布一个小程序'
    )
  })

  test('uses the cloud marketplace identity from the installed plugin source', () => {
    const plugin = pluginWithSkill()
    plugin.metadata.namespace = 'default'
    plugin.spec.source.marketplace = 'wegent'
    plugin.spec.sourcePayload = { filename: 'wegent-sites.zip' }

    expect(pluginTrialInput(plugin)).toBe('[$Documents](plugin://documents@wegent) ')
  })

  test('falls back to the workspace marketplace for managed marketplace installs', () => {
    const plugin = pluginWithSkill()
    plugin.metadata.namespace = 'default'
    plugin.spec.source = {
      type: 'marketplace',
      providerKey: 'wegent-market',
      pluginKey: 'documents',
    }
    plugin.spec.sourcePayload = { filename: 'documents.zip' }

    expect(pluginTrialInput(plugin)).toBe('[$Documents](plugin://documents@wegent) ')
  })

  test('uses visibility over stale source marketplace for managed marketplace installs', () => {
    const plugin = pluginWithSkill()
    plugin.metadata.namespace = 'default'
    plugin.spec.visibility = 'workspace'
    plugin.spec.source = {
      type: 'marketplace',
      providerKey: 'wegent-market',
      pluginKey: 'documents',
      marketplace: 'wework',
    }
    plugin.spec.sourcePayload = { filename: 'documents.zip' }

    expect(pluginTrialInput(plugin)).toBe('[$Documents](plugin://documents@wegent) ')
  })

  test('falls back to the public marketplace for public managed installs', () => {
    const plugin = pluginWithSkill()
    plugin.metadata.namespace = 'default'
    plugin.spec.visibility = 'public'
    plugin.spec.source = {
      type: 'marketplace',
      providerKey: 'wegent-market',
      pluginKey: 'documents',
    }
    plugin.spec.sourcePayload = { filename: 'documents.zip' }

    expect(pluginTrialInput(plugin)).toBe('[$Documents](plugin://documents@wework) ')
  })

  test('falls back to the personal marketplace for personal managed installs', () => {
    const plugin = pluginWithSkill()
    plugin.metadata.namespace = 'default'
    plugin.spec.visibility = 'personal'
    plugin.spec.source = {
      type: 'marketplace',
      providerKey: 'wegent-market',
      pluginKey: 'documents',
    }
    plugin.spec.sourcePayload = { filename: 'documents.zip' }

    expect(pluginTrialInput(plugin)).toBe('[$Documents](plugin://documents@wework-personal) ')
  })

  test('queues and consumes plugin trial input once', () => {
    expect(queuePluginTrial(pluginWithSkill('/tmp/plugin/skills/report/SKILL.md'))).toBe(true)
    expect(consumePluginTrialInput()).toBe('[$Documents](plugin://documents@OpenAI Bundled) ')
    expect(consumePluginTrialInput()).toBeNull()
  })

  test('queues a canonical plugin reference without an installed plugin record', () => {
    expect(
      queuePluginReferenceTrial({
        pluginName: 'sites',
        marketplaceName: 'openai-bundled',
        displayName: 'Sites',
      })
    ).toBe(true)
    expect(consumePluginTrialInput()).toBe('[$Sites](plugin://sites@openai-bundled) ')
  })

  test('queues plugin templates for the trial composer', () => {
    expect(
      queuePluginTrial(pluginWithSkill('/tmp/plugin/skills/report/SKILL.md'), {
        openInNewChat: true,
      })
    ).toBe(true)
    const trial = consumePluginTrial()
    expect(trial?.templates).toEqual([
      {
        name: 'Project Memo',
        path: 'project_memo',
        description: 'Draft a project memo',
        logoUrl: 'https://example.com/memo.png',
      },
    ])
    expect(trial?.app).toEqual(
      expect.objectContaining({
        id: 'plugin:documents',
        name: 'Documents',
        pluginKey: 'documents',
        source: 'installed-plugin',
      })
    )
    expect(trial?.openInNewChat).toBe(true)
  })

  test('builds useful guide scenarios when a plugin has no templates or default prompts', () => {
    const plugin = pluginWithSkill('/tmp/plugin/skills/report/SKILL.md')
    plugin.spec.components.templates = []
    plugin.spec.components.commands = []

    expect(pluginTrialTemplates(plugin)).toEqual([
      expect.objectContaining({
        path: 'prompt-0',
        description: 'Use Documents to summarize the current context and propose next steps',
      }),
      expect.objectContaining({ path: 'prompt-1' }),
      expect.objectContaining({ path: 'prompt-2' }),
    ])
  })

  test('keeps the selected detail scenario first in the chat guide', () => {
    const plugin = pluginWithSkill('/tmp/plugin/skills/report/SKILL.md')
    plugin.spec.components.templates = []
    plugin.spec.components.commands = []

    expect(queuePluginPromptTrial(plugin, 'Review the quarterly report for inconsistencies')).toBe(
      true
    )
    expect(consumePluginTrial()?.templates[0]).toEqual({
      name: 'Review the quarterly report for inconsistencies',
      path: 'selected-use-case',
      description: 'Review the quarterly report for inconsistencies',
    })
  })

  test('keeps a refined detail task concise and removes the duplicate base scenario', () => {
    const plugin = pluginWithSkill('/tmp/plugin/skills/report/SKILL.md')
    plugin.spec.components.templates = [
      {
        name: 'Review my current working-tree changes.',
        path: 'current-changes',
        description: 'Review my current working-tree changes.',
      },
      {
        name: 'Review this branch against its merge base.',
        path: 'branch',
        description: 'Review this branch against its merge base.',
      },
    ]

    expect(
      pluginTrialTemplates(
        plugin,
        'Review my current working-tree changes.\nFocus: inspect architecture impact'
      )
    ).toEqual([
      {
        name: 'Review my current working-tree changes.',
        path: 'selected-use-case',
        description: 'Review my current working-tree changes.\nFocus: inspect architecture impact',
      },
      expect.objectContaining({ path: 'branch' }),
    ])
  })

  test('tracks plugin usage for the 30-day guide gate', () => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    expect(getPluginUseCount30d('Sites')).toBe(0)
    expect(shouldShowPluginTrialGuide('Sites', 'scope-a')).toBe(true)
    recordPluginUsage('Sites')
    expect(getPluginUseCount30d('Sites')).toBe(1)
    expect(shouldShowPluginTrialGuide('Sites', 'scope-a')).toBe(false)
    dismissTrialGuide('Docs', 'scope-a')
    expect(shouldShowPluginTrialGuide('Docs', 'scope-a')).toBe(false)
  })

  test('records plugin usage from composer mentions', () => {
    window.localStorage.clear()
    recordPluginUsageFromInput('[$Sites](plugin://sites@openai-bundled) summarize this repo')
    expect(getPluginUseCount30d('Sites')).toBe(1)
  })

  test('builds trial template prompts from the current plugin mention', () => {
    expect(
      buildTrialTemplatePrompt('[$Sites](plugin://sites@openai-bundled) ', {
        name: 'Project Memo',
        path: 'project_memo',
        description: 'Draft a project memo',
      })
    ).toBe('[$Sites](plugin://sites@openai-bundled) Draft a project memo ')
  })

  test('builds a conversation-aware task while preserving the plugin mention and current idea', () => {
    expect(
      buildContextualPluginPrompt(
        '[$Sites](plugin://sites@openai-bundled) Build a launch page',
        'Use the recent conversation to complete the task.',
        'My current idea'
      )
    ).toBe(
      '[$Sites](plugin://sites@openai-bundled) Use the recent conversation to complete the task.\n\nMy current idea: Build a launch page '
    )
  })

  test('applies an AI-refined task while preserving the plugin mention', () => {
    expect(
      buildRefinedPluginPrompt(
        '[$Sites](plugin://sites@openai-bundled) rough idea',
        'Build a launch page for the Q4 campaign'
      )
    ).toBe('[$Sites](plugin://sites@openai-bundled) Build a launch page for the Q4 campaign ')
  })
})
