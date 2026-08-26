// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  buildSubtitlesFromSrt,
  buildSrt,
  loadBgmTasks,
  loadSubTasks,
  removeBgmTask,
  removeSubTask,
  saveBgmTask,
  saveSubTask,
} from '@wecode/features/video/composition/utils'

describe('video composition utilities', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('parses and rebuilds clip-local SRT timestamps', () => {
    const subtitles = buildSubtitlesFromSrt('1\n00:00:01,250 --> 00:00:03,500\nAutumn light', 12, 8)

    expect(subtitles).toEqual([
      expect.objectContaining({
        storyboard_id: 12,
        start: 9.25,
        end: 11.5,
        clip_local_start: 1.25,
        clip_local_end: 3.5,
        text: 'Autumn light',
      }),
    ])
    expect(buildSrt(subtitles)).toBe('1\n00:00:01,250 --> 00:00:03,500\nAutumn light')
  })

  test('persists pending BGM tasks per script and removes completed tasks', () => {
    saveBgmTask(31, 2, 'bgm-task')
    saveBgmTask(32, 0, 'other-task')

    expect(loadBgmTasks(31)).toEqual([
      {
        task_uuid: 'bgm-task',
        idx: 2,
      },
    ])

    removeBgmTask(31, 2)
    expect(loadBgmTasks(31)).toEqual([])
    expect(loadBgmTasks(32)).toHaveLength(1)
  })

  test('persists pending subtitle tasks per storyboard', () => {
    saveSubTask(31, 7, 19, 'subtitle-task')

    expect(loadSubTasks(31)).toEqual([
      {
        task_uuid: 'subtitle-task',
        storyboard_id: 7,
        clip_id: 19,
      },
    ])

    removeSubTask(31, 7)
    expect(loadSubTasks(31)).toEqual([])
  })

  test('discards malformed task cache entries', () => {
    window.localStorage.setItem('wegent_bgm_task_31_0', '{broken')
    window.localStorage.setItem('wegent_sub_task_31_7', JSON.stringify({ task_uuid: '' }))

    expect(loadBgmTasks(31)).toEqual([])
    expect(loadSubTasks(31)).toEqual([])
    expect(window.localStorage.length).toBe(0)
  })
})
