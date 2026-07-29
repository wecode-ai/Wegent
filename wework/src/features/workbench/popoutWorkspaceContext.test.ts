import { describe, expect, test } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/api'
import {
  getPopoutComposerPlaceholder,
  mergePopoutWorkspaceProjects,
} from './popoutWorkspaceContext'

describe('popoutWorkspaceContext', () => {
  test('keeps the composer placeholder aligned with the selected launch mode', () => {
    expect(getPopoutComposerPlaceholder('wework_video', 'current_workspace')).toEqual({
      key: 'workbench.popout_current_workspace_placeholder',
      values: { project: 'wework_video' },
    })
    expect(getPopoutComposerPlaceholder('wework_video', 'git_worktree')).toEqual({
      key: 'workbench.popout_worktree_placeholder',
      values: { project: 'wework_video' },
    })
    expect(getPopoutComposerPlaceholder(null, 'current_workspace')).toEqual({
      key: 'workbench.popout_projectless_placeholder',
    })
  })

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
