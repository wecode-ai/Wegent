import { describe, expect, it, vi } from 'vitest'

import type { HttpClient } from './http'
import { createAgentResourceApi } from './agentResources'

describe('createAgentResourceApi', () => {
  it('creates the bot and team in the requested namespace with exact Skill and MCP refs', async () => {
    const client = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValueOnce({ id: 41 }).mockResolvedValueOnce({
        id: 52,
        name: 'review-agent',
        displayName: 'Review Agent',
        namespace: 'workspace-alpha',
      }),
    } as unknown as HttpClient
    const api = createAgentResourceApi(client)

    const created = await api.createAgent({
      name: 'review-agent',
      displayName: 'Review Agent',
      namespace: 'workspace-alpha',
      runtime: 'ClaudeCode',
      systemPrompt: 'Review the implementation.',
      skills: [
        {
          skillId: 7,
          name: 'code-review',
          namespace: 'workspace-alpha',
          isPublic: false,
        },
      ],
      mcpServers: {
        browser: {
          command: 'node',
          args: ['browser.mjs'],
        },
      },
    })

    expect(client.post).toHaveBeenNthCalledWith(1, '/bots', {
      name: 'review-agent-bot',
      shell_name: 'ClaudeCode',
      agent_config: {},
      system_prompt: 'Review the implementation.',
      mcp_servers: {
        browser: {
          command: 'node',
          args: ['browser.mjs'],
        },
      },
      skills: ['code-review'],
      skill_refs: {
        'code-review': {
          skill_id: 7,
          namespace: 'workspace-alpha',
          is_public: false,
        },
      },
      preload_skills: [],
      preload_skill_refs: {},
      target_group_names: ['workspace-alpha'],
      namespace: 'workspace-alpha',
    })
    expect(client.post).toHaveBeenNthCalledWith(2, '/teams', {
      name: 'review-agent',
      displayName: 'Review Agent',
      description: '',
      workflow: {
        mode: 'solo',
        leader_bot_id: 41,
      },
      bind_mode: ['code', 'task'],
      bots: [
        {
          bot_id: 41,
          bot_prompt: '',
          role: 'leader',
        },
      ],
      namespace: 'workspace-alpha',
      requires_workspace: true,
    })
    expect(created).toEqual({
      id: 52,
      name: 'review-agent',
      displayName: 'Review Agent',
      namespace: 'workspace-alpha',
    })
  })

  it('loads the unified accessible Skill catalog', async () => {
    const client = {
      get: vi.fn(async () => []),
    } as unknown as HttpClient
    const api = createAgentResourceApi(client)

    await api.listSkills()

    expect(client.get).toHaveBeenCalledWith('/v1/kinds/skills/unified?scope=all')
  })

  it('loads the unified executable model catalog', async () => {
    const client = {
      get: vi.fn(async () => ({
        data: [{ name: 'gpt-5.4', type: 'public' }],
      })),
    } as unknown as HttpClient
    const api = createAgentResourceApi(client)

    await expect(api.listModels()).resolves.toEqual([{ name: 'gpt-5.4', type: 'public' }])

    expect(client.get).toHaveBeenCalledWith(
      '/models/unified?include_config=true&scope=all&model_category_type=llm&client_origin=wework'
    )
  })

  it('creates a personal Codex Agent without group authorization context', async () => {
    const client = {
      post: vi.fn().mockResolvedValueOnce({ id: 61 }).mockResolvedValueOnce({
        id: 62,
        name: 'codex-agent',
        namespace: 'default',
      }),
    } as unknown as HttpClient
    const api = createAgentResourceApi(client)

    await api.createAgent({
      name: 'codex-agent',
      displayName: '',
      namespace: 'default',
      runtime: 'Codex',
      model: {
        name: 'gpt-5.4',
        type: 'public',
        namespace: 'default',
      },
      systemPrompt: '',
      skills: [],
      mcpServers: {},
    })

    expect(client.post).toHaveBeenNthCalledWith(
      1,
      '/bots',
      expect.objectContaining({
        agent_config: {
          bind_model: 'gpt-5.4',
          bind_model_type: 'public',
        },
        shell_name: 'Codex',
        namespace: 'default',
        target_group_names: [],
      })
    )
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      '/teams',
      expect.objectContaining({
        name: 'codex-agent',
        namespace: 'default',
      })
    )
  })
})
