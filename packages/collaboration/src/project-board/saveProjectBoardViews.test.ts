// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import type { CollaborationProject } from '../types'
import { saveProjectBoardViews } from './saveProjectBoardViews'
import { collectProjectTags } from './projectTags'

const config = {
  schema_version: 1,
  views: [],
  futureField: { keepCase: true },
}
const translate = createCollaborationTranslator('zh-CN')
const project = {
  id: 'one',
  version: 2,
  board_views: config,
} as CollaborationProject

describe('saved view persistence', () => {
  it('persists view, default and display changes in one versioned project write', async () => {
    const api = { update: vi.fn().mockResolvedValue(project), get: vi.fn() }
    const settings = {
      isDefault: true,
      cardDisplay: { show_assignee: false, show_priority: true, show_tags: true, show_date: true },
    }
    await saveProjectBoardViews({
      api,
      projectId: 'one',
      version: 1,
      config: { ...config, default_view_id: 'default' },
      settings,
      accept: vi.fn(),
      translate,
    })
    expect(api.update).toHaveBeenCalledExactlyOnceWith('one', {
      version: 1,
      boardViews: { ...config, default_view_id: 'default' },
      cardDisplay: settings.cardDisplay,
    })
  })
  it('uses the project version and publishes the acknowledged document', async () => {
    const api = { update: vi.fn().mockResolvedValue(project), get: vi.fn() }
    const accept = vi.fn()
    await saveProjectBoardViews({
      api,
      projectId: 'one',
      version: 1,
      config,
      accept,
      translate,
    })
    expect(api.update).toHaveBeenCalledExactlyOnceWith('one', {
      version: 1,
      boardViews: config,
    })
    expect(accept).toHaveBeenCalledWith(project)
    expect(api.get).not.toHaveBeenCalled()
  })
  it.each([{ status: 409 }, { code: 'version_conflict' }])(
    'refreshes a conflict without overwriting newer views (%j)',
    async error => {
      const api = {
        update: vi.fn().mockRejectedValue(error),
        get: vi.fn().mockResolvedValue(project),
      }
      const accept = vi.fn()
      await expect(
        saveProjectBoardViews({
          api,
          projectId: 'one',
          version: 1,
          config,
          accept,
          translate,
        })
      ).rejects.toThrow('项目已被更新')
      expect(api.update).toHaveBeenCalledOnce()
      expect(api.get).toHaveBeenCalledExactlyOnceWith('one')
      expect(accept).toHaveBeenCalledWith(project)
    }
  )
  it('does not report success when an older server silently ignores the field', async () => {
    const api = {
      update: vi.fn().mockResolvedValue({ ...project, board_views: undefined }),
      get: vi.fn(),
    }
    const accept = vi.fn()
    await expect(
      saveProjectBoardViews({
        api,
        projectId: 'one',
        version: 1,
        config,
        accept,
        translate,
      })
    ).rejects.toThrow('服务端不支持')
    expect(accept).not.toHaveBeenCalled()
  })

  it('discovers persisted lane and filter tags without duplicating the limited project registry', async () => {
    const config = {
      schema_version: 1,
      views: [
        {
          id: 'mixed',
          name: 'Mixed',
          columns: [
            { id: 'inbox', type: 'status' as const, value: 'inbox' },
            { id: 'test', type: 'tag' as const, value: '测试' },
            { id: 'bug', type: 'tag' as const, value: 'bug' },
          ],
          filter: { tags: ['需求', 'bug'] },
        },
      ],
    }
    const api = {
      update: vi.fn().mockResolvedValue({ ...project, board_views: config }),
      get: vi.fn(),
    }
    await saveProjectBoardViews({
      api,
      projectId: 'one',
      version: 1,
      config,
      accept: vi.fn(),
      translate,
    })
    expect(api.update).toHaveBeenCalledExactlyOnceWith('one', {
      version: 1,
      boardViews: config,
    })
    expect(collectProjectTags({ tags: ['bug'], board_views: config })).toEqual([
      'bug',
      '测试',
      '需求',
    ])
  })
})
