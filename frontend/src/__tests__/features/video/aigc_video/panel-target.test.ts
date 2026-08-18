// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  parseVideoPanelTarget,
  resolveVideoPanelSessionId,
} from '@/features/video/aigc_video/AigcVideoPanel'

describe('parseVideoPanelTarget', () => {
  test('parses material-video async card links', () => {
    expect(
      parseVideoPanelTarget(
        '/chat?openPanel=narrative-framework&session_id=25&task_uuid=narration_async_7'
      )
    ).toEqual({
      panel: 'narrative-framework',
      sessionId: '25',
      taskUuid: 'narration_async_7',
      scriptId: undefined,
      taskId: undefined,
      index: 0,
    })
  })

  test('keeps existing storyboard links compatible', () => {
    expect(
      parseVideoPanelTarget('/chat?openPanel=storyboard&scriptId=8&taskId=25&index=2')
    ).toEqual({
      panel: 'storyboard',
      sessionId: undefined,
      taskUuid: undefined,
      scriptId: 8,
      taskId: 25,
      index: 2,
    })
  })

  test('parses entity-preview links', () => {
    expect(parseVideoPanelTarget('/chat?taskId=27&scriptId=13&openPanel=entity')).toEqual({
      panel: 'entity',
      sessionId: undefined,
      taskUuid: undefined,
      scriptId: 13,
      taskId: 27,
      index: 0,
    })
  })

  test('uses the task id as the timeline session when session_id is missing', () => {
    const target = parseVideoPanelTarget('/chat?taskId=37&openPanel=timeline')

    expect(resolveVideoPanelSessionId(target)).toBe('37')
  })

  test('uses the card task fallback as the timeline session', () => {
    const target = parseVideoPanelTarget('/chat?openPanel=timeline')

    expect(resolveVideoPanelSessionId(target, 37)).toBe('37')
  })
})
