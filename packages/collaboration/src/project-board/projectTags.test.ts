// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import type { ProjectBoardViews } from './projectBoardViews'
import { collectProjectTags, updateBoardViewTag } from './projectTags'

const t = createCollaborationTranslator('zh-CN')
const config: ProjectBoardViews = {
  schema_version: 1,
  future: { keep: true },
  views: [
    {
      id: 'mixed',
      name: '测试视图',
      future: true,
      columns: [
        { id: 'inbox', type: 'status', value: 'inbox' },
        { id: 'test', type: 'tag', value: '测试', future: true },
        { id: 'bug', type: 'tag', value: 'bug' },
      ],
      filter: { tags: ['测试', '需求'], match: 'any', future: true },
      sorts: { inbox: ['created-desc'], test: ['priority-desc'] },
    },
  ],
}

describe('project tag catalog and view references', () => {
  it('includes unused historical view tags as well as registry and item tags', () => {
    expect(
      collectProjectTags({ tags: ['bug'], board_views: config }, [{ tags: ['task-only', 'bug'] }])
    ).toEqual(['bug', 'task-only', '测试', '需求'])
    expect(collectProjectTags({ tags: ['bug'] })).toEqual(['bug'])
  })
  it('keeps a view catalog larger than the legacy project registry limit', () => {
    const tags = Array.from({ length: 25 }, (_, index) => `tag-${index}`)
    const board_views = { ...config, views: [{ ...config.views[0], filter: { tags } }] }
    expect(collectProjectTags({ tags: ['bug'], board_views })).toEqual(['bug', '测试', ...tags])
  })
  it('renames all references without changing status bindings or unknown fields', () => {
    const updated = updateBoardViewTag(config, '测试', '验证', t)!
    const original = config.views[0]
    expect(updated).toEqual({
      ...config,
      views: [
        {
          ...original,
          columns: original.columns.map(column =>
            column.id === 'test' ? { ...column, value: '验证' } : column
          ),
          filter: { ...original.filter, tags: ['验证', '需求'] },
        },
      ],
    })
    expect(config.views[0].columns[1].value).toBe('测试')
  })
  it('removes a deleted tag from lanes, filters and lane sorts', () => {
    const updated = updateBoardViewTag(config, '测试', null, t)!
    expect(updated.views[0]).toEqual({
      ...config.views[0],
      columns: [config.views[0].columns[0], config.views[0].columns[2]],
      filter: { ...config.views[0].filter, tags: ['需求'] },
      sorts: { inbox: ['created-desc'] },
    })
    expect(collectProjectTags({ board_views: updated })).toEqual(['bug', '需求'])
  })
  it('rejects removing the only lane before any data can be changed', () => {
    const single = {
      ...config,
      views: [{ ...config.views[0], columns: [config.views[0].columns[1]] }],
    }
    expect(() => updateBoardViewTag(single, '测试', null, t)).toThrow('唯一泳道')
  })
  it('preserves future documents and leaves unrelated views untouched', () => {
    expect(updateBoardViewTag(config, 'unused', null, t)).toBeUndefined()
    expect(() => updateBoardViewTag({ schema_version: 2, views: [] }, 'bug', null, t)).toThrow(
      '更新版本'
    )
    expect(
      collectProjectTags({ tags: ['bug'], board_views: { schema_version: 2, views: [] } })
    ).toEqual(['bug'])
  })
})
