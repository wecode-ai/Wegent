// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { adminApis, type AdminPublicBot } from '@/apis/admin'
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

describe('publicResourceApis', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('preserves public bot preload skill fields from admin responses', () => {
    const bot = transformPublicBotToBot(adminPublicBot)

    expect(bot.preload_skills).toEqual(['repo-reader'])
    expect(bot.preload_skill_refs).toEqual(adminPublicBot.preload_skill_refs)
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
})
