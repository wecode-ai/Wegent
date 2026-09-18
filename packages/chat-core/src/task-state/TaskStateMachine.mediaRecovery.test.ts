// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageBlock } from '../message-blocks'
import { TaskStateMachine } from './TaskStateMachine'

afterEach(() => vi.restoreAllMocks())

describe('media placeholder recovery', () => {
  it.each(['image', 'video'] as const)(
    'restores the original %s placeholder from the stream cache',
    async mediaType => {
      vi.spyOn(console, 'info').mockImplementation(() => {})
      const block = {
        id: `${mediaType}-original`,
        type: mediaType,
        status: 'streaming',
        is_placeholder: true,
        content: '',
        timestamp: Date.parse('2026-09-17T02:23:45Z'),
        ...(mediaType === 'image'
          ? { image_urls: [], image_count: 0, image_size: '1512x648' }
          : { video_url: '', video_progress: 35 }),
      } as MessageBlock
      const machine = new TaskStateMachine(42, {
        isConnected: () => true,
        joinTask: vi.fn().mockResolvedValue({
          streaming: { subtask_id: 77, cached_content: '', offset: 0, blocks: [block] },
          subtasks: [
            {
              id: 76,
              role: 'USER',
              status: 'COMPLETED',
              result: { [`${mediaType}_config`]: { model: 'media-model', size: '1512x648' } },
              created_at: '2026-09-17T02:23:40Z',
            },
            {
              id: 77,
              role: 'ASSISTANT',
              status: 'RUNNING',
              result: { value: '' },
              created_at: '2026-09-17T02:23:41Z',
            },
          ],
        }),
      })

      await machine.recover({ force: true })

      const message = machine.getState().messages.get('ai-77')
      expect(message?.status).toBe('streaming')
      expect(message?.result?.blocks).toEqual([block])
    }
  )

  it('restores persisted video progress while asynchronous polling is running', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const block = {
      id: 'video-polling',
      type: 'video',
      status: 'streaming',
      is_placeholder: true,
      video_url: '',
      video_progress: 65,
      content: '',
      timestamp: Date.parse('2026-09-17T02:23:45Z'),
    }
    const machine = new TaskStateMachine(42, {
      isConnected: () => true,
      joinTask: vi.fn().mockResolvedValue({
        streaming: { subtask_id: 77, cached_content: '', offset: 0, blocks: [] },
        subtasks: [
          {
            id: 77,
            role: 'ASSISTANT',
            status: 'RUNNING',
            result: { value: '', blocks: [block], video_job: { status: 'polling' } },
            created_at: '2026-09-17T02:23:41Z',
          },
        ],
      }),
    })

    await machine.recover({ force: true })

    const message = machine.getState().messages.get('ai-77')
    expect(message?.status).toBe('streaming')
    expect(message?.result?.blocks).toEqual([block])
  })
})
