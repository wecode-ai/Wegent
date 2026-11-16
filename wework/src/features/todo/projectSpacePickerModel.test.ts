// @vitest-environment node

import type { CloudProject } from '@/api/deliveries'
import { describe, expect, test } from 'vitest'
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
  test('groups by local and remote storage while retaining optional space search', () => {
    const scoped = project('remote', 'Shared project', {
      workspace_context: { id: 'space', public_id: 'public-space', name: 'Design team' },
    })
    const entries = projectSpacePickerEntries(
      [project('local', 'Offline project', { project_store: 'local' }), scoped],
      labels,
      'storage'
    )
    expect(entries.map(entry => entry.group.key)).toEqual(['local', 'backend'])
    expect(searchProjectSpaceEntries(entries, 'Design team').map(entry => entry.project)).toEqual([
      scoped,
    ])
    expect(scoped.workspace_context?.id).toBe('space')
  })

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

  test.each(['workspace', 'storage'] as const)(
    'breaks identical-name ties by space and identity independently of %s grouping',
    grouping => {
      const spaceA = { id: 'a', public_id: 'ws-a', name: 'Space A' }
      const spaceB = { id: 'b', public_id: 'ws-b', name: 'Space B' }
      const entries = projectSpacePickerEntries(
        [
          project('b', '周报', { workspace_context: spaceB }),
          project('z', '周报', { workspace_context: spaceA }),
          project('a', '周报', { workspace_context: spaceA }),
        ],
        labels,
        grouping
      )

      for (const order of ['name-asc', 'name-desc'] as const) {
        const sorted = sortProjectSpaceEntries(entries, order, 'zh-CN')
        expect(sorted.map(entry => entry.key)).toEqual(['backend:a', 'backend:z', 'backend:b'])
        expect(sortProjectSpaceEntries([...entries].reverse(), order, 'zh-CN')).toEqual(sorted)
      }
    }
  )
})
