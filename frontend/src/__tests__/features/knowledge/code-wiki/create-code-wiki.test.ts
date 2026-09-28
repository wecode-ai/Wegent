// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { codeWikiApi } from '@/apis/code-wiki'
import { createCodeWiki } from '@/features/knowledge/code-wiki/createCodeWiki'

jest.mock('@/apis/code-wiki', () => ({
  codeWikiApi: { create: jest.fn(), configureScheduledUpdate: jest.fn() },
}))

describe('createCodeWiki', () => {
  beforeEach(() => jest.clearAllMocks())

  it('forwards the complete form through the dedicated API without UI-only fields', async () => {
    jest.mocked(codeWikiApi.create).mockResolvedValue({
      id: 17,
      name: 'Wegent',
      project_name: 'wecode-ai/Wegent',
      source_url: 'https://github.com/wecode-ai/Wegent.git',
      last_published_commit: '',
      document_count: 0,
      created_at: '2026-08-11T00:00:00Z',
      updated_at: '2026-08-11T00:00:00Z',
    })

    await createCodeWiki({
      namespace: 'team-a',
      data: {
        name: '',
        description: undefined,
        kb_type: 'code_wiki',
        source_type: 'github',
        source_url: 'https://github.com/wecode-ai/Wegent.git',
        language: 'zh',
        resolved_name: 'Wegent',
        resolved_description: 'Agent platform',
        execution_model_ref: { name: 'model-a', namespace: 'default', type: 'public' },
        selectedGroupId: 'group-team-a',
      },
    })

    expect(codeWikiApi.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Wegent',
        description: 'Agent platform',
        namespace: 'team-a',
        source_type: 'github',
        source_url: 'https://github.com/wecode-ai/Wegent.git',
        language: 'zh',
        execution_model_ref: { name: 'model-a', namespace: 'default', type: 'public' },
      })
    )
    expect(codeWikiApi.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ kb_type: expect.anything() })
    )
    expect(codeWikiApi.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ selectedGroupId: expect.anything() })
    )
  })

  it('rejects forms without the required repository or execution model', async () => {
    await expect(
      createCodeWiki({
        namespace: 'team-a',
        data: {
          name: 'Wegent',
          kb_type: 'code_wiki',
          source_type: 'github',
          source_url: '',
        },
      })
    ).rejects.toThrow('Code Wiki creation requires a repository and execution model')
  })

  it('configures optional future updates only after the wiki exists', async () => {
    jest.mocked(codeWikiApi.create).mockResolvedValue({
      id: 17,
      name: 'Wegent',
      project_name: 'wecode-ai/Wegent',
      source_url: 'https://github.com/wecode-ai/Wegent.git',
      last_published_commit: '',
      document_count: 0,
      created_at: '2026-08-11T00:00:00Z',
      updated_at: '2026-08-11T00:00:00Z',
    })
    const schedule = {
      enabled: true,
      cadence: 'daily' as const,
      interval_days: 1,
      weekday: 0,
      hour: 9,
      minute: 0,
      timezone: 'Asia/Shanghai',
    }

    await createCodeWiki({
      namespace: 'default',
      data: {
        name: 'Wegent',
        kb_type: 'code_wiki',
        source_type: 'github',
        source_url: 'https://github.com/wecode-ai/Wegent.git',
        execution_model_ref: { name: 'model-a', namespace: 'default', type: 'public' },
        scheduled_update: schedule,
      },
    })

    expect(codeWikiApi.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ scheduled_update: expect.anything() })
    )
    expect(codeWikiApi.configureScheduledUpdate).toHaveBeenCalledWith(17, schedule)
    expect(jest.mocked(codeWikiApi.create).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(codeWikiApi.configureScheduledUpdate).mock.invocationCallOrder[0]
    )
  })

  it('keeps a successfully created wiki when schedule configuration fails', async () => {
    jest.mocked(codeWikiApi.create).mockResolvedValue({
      id: 17,
      name: 'Wegent',
      project_name: 'wecode-ai/Wegent',
      source_url: 'https://github.com/wecode-ai/Wegent.git',
      last_published_commit: '',
      document_count: 0,
      created_at: '2026-08-11T00:00:00Z',
      updated_at: '2026-08-11T00:00:00Z',
    })
    jest
      .mocked(codeWikiApi.configureScheduledUpdate)
      .mockRejectedValue(new Error('Schedule service unavailable'))

    await expect(
      createCodeWiki({
        namespace: 'default',
        data: {
          name: 'Wegent',
          kb_type: 'code_wiki',
          source_type: 'github',
          source_url: 'https://github.com/wecode-ai/Wegent.git',
          execution_model_ref: { name: 'model-a', namespace: 'default', type: 'public' },
          scheduled_update: {
            enabled: true,
            cadence: 'daily',
            interval_days: 1,
            weekday: 0,
            hour: 9,
            minute: 0,
            timezone: 'Asia/Shanghai',
          },
        },
      })
    ).resolves.toMatchObject({
      id: 17,
      scheduledUpdateError: 'Schedule service unavailable',
    })
    expect(codeWikiApi.create).toHaveBeenCalledTimes(1)
  })
})
