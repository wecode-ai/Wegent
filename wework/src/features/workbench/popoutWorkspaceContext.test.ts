// @vitest-environment node

import type { RuntimeWorkListResponse } from '@/types/api'
import { describe, expect, test } from 'vitest'
import { mergePopoutWorkspaceProjects } from './popoutWorkspaceContext'

describe('popoutWorkspaceContext', () => {
  test('includes runtime projects when the persisted project list is empty', () => {
    const runtimeWork = {
      projects: [
        {
          project: {
            id: 7,
            key: 'wework-video',
            name: 'wework_video',
          },
          deviceWorkspaces: [],
        },
      ],
    } as RuntimeWorkListResponse

    expect(mergePopoutWorkspaceProjects([], runtimeWork)).toEqual([
      expect.objectContaining({ id: 7, name: 'wework_video' }),
    ])
  })
})
