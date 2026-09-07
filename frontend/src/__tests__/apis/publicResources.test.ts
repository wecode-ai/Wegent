// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { adminApis, type AdminPublicBot, type AdminPublicModel } from '@/apis/admin'
import {
  publicResourceApis,
  transformPublicBotToBot,
  type PublicBotFormData,
} from '@/apis/publicResources'

jest.mock('@/apis/admin', () => ({
  adminApis: {
    createPublicBot: jest.fn(),
    updatePublicBot: jest.fn(),
    getPublicBots: jest.fn(),
    getPublicModels: jest.fn(),
  },
}))

const skillRefs = {
  'repo-reader': {
    skill_id: 101,
    namespace: 'default',
    is_public: true,
  },
}

const adminPublicBot: AdminPublicBot = {
  id: 12,
  name: 'code-agent-bot',
  namespace: 'default',
  display_name: null,
  json: {},
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ghost_name: 'code-agent-bot-ghost',
  shell_name: 'ClaudeCode',
  model_name: null,
  system_prompt: 'Use the repo reader.',
  mcp_servers: {},
  skills: ['repo-reader'],
  skill_refs: skillRefs,
  preload_skills: ['repo-reader'],
  preload_skill_refs: skillRefs,
  agent_config: {},
  default_knowledge_base_refs: [],
}

const publicVideoModel: AdminPublicModel = {
  id: 20,
  name: 'seedance-2.5',
  namespace: 'default',
  display_name: 'Seedance 2.5',
  json: {
    metadata: {
      name: 'seedance-2.5',
      namespace: 'default',
      displayName: 'Seedance 2.5',
    },
    spec: {
      modelType: 'video',
      modelConfig: {
        env: {
          model: 'seedance',
          model_id: 'seedance-2.5',
        },
      },
    },
  },
  is_active: true,
  is_visible: true,
  is_advanced: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

describe('publicResourceApis', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('preserves public bot preload skill fields from admin responses', () => {
    const bot = transformPublicBotToBot(adminPublicBot)

    expect(bot.preload_skills).toEqual(['repo-reader'])
    expect(bot.preload_skill_refs).toEqual(adminPublicBot.preload_skill_refs)
  })

  it('preserves the Bot planning LLM reference from admin responses', () => {
    const bot = transformPublicBotToBot({
      ...adminPublicBot,
      secondary_model_name: 'planning-llm',
      secondary_model_namespace: 'default',
    })

    expect(bot.secondary_model_name).toBe('planning-llm')
    expect(bot.secondary_model_namespace).toBe('default')
  })

  it('forwards preload skill fields when creating public bots', async () => {
    const formData: PublicBotFormData = {
      name: 'code-agent-bot',
      namespace: 'default',
      shell_name: 'ClaudeCode',
      system_prompt: 'Use the repo reader.',
      mcp_servers: {},
      skills: ['repo-reader'],
      skill_refs: skillRefs,
      preload_skills: ['repo-reader'],
      preload_skill_refs: skillRefs,
      agent_config: {},
      default_knowledge_base_refs: [],
    }
    ;(adminApis.createPublicBot as jest.Mock).mockResolvedValue(adminPublicBot)

    await publicResourceApis.createPublicBot(formData)

    expect(adminApis.createPublicBot).toHaveBeenCalledWith(
      expect.objectContaining({
        preload_skills: ['repo-reader'],
        preload_skill_refs: skillRefs,
      })
    )
  })

  it('forwards the planning LLM when creating public video bots', async () => {
    const formData: PublicBotFormData = {
      name: 'test-video-bot',
      namespace: 'default',
      shell_name: 'Chat',
      agent_config: {
        bind_model: 'seedance-2.5',
        bind_model_type: 'public',
        bind_model_namespace: 'default',
      },
      secondary_model_name: 'planning-llm',
      secondary_model_namespace: 'default',
    }
    ;(adminApis.createPublicBot as jest.Mock).mockResolvedValue(adminPublicBot)

    await publicResourceApis.createPublicBot(formData)

    expect(adminApis.createPublicBot).toHaveBeenCalledWith(
      expect.objectContaining({
        secondary_model_name: 'planning-llm',
        secondary_model_namespace: 'default',
      })
    )
  })

  it('returns public video models for the video category', async () => {
    ;(adminApis.getPublicModels as jest.Mock).mockResolvedValue({
      total: 1,
      items: [publicVideoModel],
    })

    const models = await publicResourceApis.getPublicModels(undefined, 'video')

    expect(models).toEqual([
      expect.objectContaining({
        name: 'seedance-2.5',
        displayName: 'Seedance 2.5',
        modelCategoryType: 'video',
      }),
    ])
  })
})
