import { describe, expect, test } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import {
  projectSpacePickerEntries,
  searchProjectSpaceEntries,
  sortProjectSpaceEntries,
} from './projectSpacePickerModel'

function project(id: string, name: string, overrides: Partial<CloudProject> = {}): CloudProject {
  return {
    id,
    name,
    public_id: `public-${id}`,
    project_key: id.toUpperCase(),
    project_store: 'backend',
    description: '',
    task_provider: 'native',
    provider_config: {},
    created_by_user_id: 1,
    status: 'active',
    tags: [],
    version: 1,
    created_at: '2026-10-20T00:00:00Z',
    updated_at: '2026-10-20T00:00:00Z',
    ...overrides,
  }
}

const labels = { local: '本地项目', cloud: '云端项目' }

describe('project space picker model', () => {
  test('keeps same-named workspaces and same-ID storage entries distinct', () => {
    const entries = projectSpacePickerEntries(
      [
        project('1', '周报', { project_store: 'local' }),
        project('1', '周报'),
        project('2', '周报', {
          workspace_context: { id: 'a', public_id: 'ws-a', name: '同名空间' },
        }),
        project('3', '周报', {
          workspace_context: { id: 'b', public_id: 'ws-b', name: '同名空间' },
        }),
      ],
      labels
    )

    expect(entries.map(entry => entry.key)).toEqual([
      'local:1',
      'backend:1',
      'backend:2',
      'backend:3',
    ])
    expect(entries.map(entry => entry.group.key)).toEqual([
      'local',
      'backend',
      'backend:a',
      'backend:b',
    ])
    expect(entries.map(entry => entry.group.label)).toEqual([
      '本地项目',
      '云端项目',
      '同名空间',
      '同名空间',
    ])
  })

  test('searches names, workspace names and keys together with normalized input', () => {
    const entries = projectSpacePickerEntries(
      [
        project('report', '行业周报', {
          workspace_context: { id: 'dev', public_id: 'ws-dev', name: '产品研发' },
        }),
        project('weekly', '行业周报', {
          workspace_context: { id: 'ops', public_id: 'ws-ops', name: '运营协作' },
        }),
      ],
      labels
    )

    expect(
      searchProjectSpaceEntries(entries, ' 周报  产品 ').map(entry => entry.project.id)
    ).toEqual(['report'])
    expect(
      searchProjectSpaceEntries(entries, 'ｗｅｅｋｌｙ').map(entry => entry.project.id)
    ).toEqual(['weekly'])
    expect(
      searchProjectSpaceEntries(entries, 'public-report').map(entry => entry.project.id)
    ).toEqual(['report'])
    expect(searchProjectSpaceEntries(entries, '不存在')).toEqual([])
    expect(searchProjectSpaceEntries(entries, '  ')).toEqual(entries)
  })

  test('sorts Chinese names by pinyin and embedded numbers naturally without mutating input', () => {
    const entries = projectSpacePickerEntries(
      [
        project('z', '知识库'),
        project('10', 'Project 10'),
        project('a', '阿尔法'),
        project('2', 'project 2'),
      ],
      labels
    )
    const original = [...entries]

    const sorted = sortProjectSpaceEntries(entries, 'name-asc', 'zh-CN')
    expect(
      sorted.filter(entry => /[0-9]/.test(entry.project.name)).map(entry => entry.project.id)
    ).toEqual(['2', '10'])
    expect(
      sorted
        .filter(entry => /[\u4e00-\u9fff]/.test(entry.project.name))
        .map(entry => entry.project.id)
    ).toEqual(['a', 'z'])
    expect(sortProjectSpaceEntries(entries, 'name-desc', 'zh-CN').map(entry => entry.key)).toEqual(
      sorted.map(entry => entry.key).reverse()
    )
    expect(entries).toEqual(original)
  })

  test('breaks identical-name ties by space and identity independently of catalog order', () => {
    const spaceA = { id: 'a', public_id: 'ws-a', name: 'Space A' }
    const spaceB = { id: 'b', public_id: 'ws-b', name: 'Space B' }
    const entries = projectSpacePickerEntries(
      [
        project('b', '周报', { workspace_context: spaceB }),
        project('z', '周报', { workspace_context: spaceA }),
        project('a', '周报', { workspace_context: spaceA }),
      ],
      labels
    )

    for (const order of ['name-asc', 'name-desc'] as const) {
      const sorted = sortProjectSpaceEntries(entries, order, 'zh-CN')
      expect(sorted.map(entry => entry.key)).toEqual(['backend:a', 'backend:z', 'backend:b'])
      expect(sortProjectSpaceEntries([...entries].reverse(), order, 'zh-CN')).toEqual(sorted)
    }
  })
})
