// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import { storyboardApis } from '@wecode/features/video/storyboard/api'

jest.mock('@/apis/client', () => ({
  apiClient: {
    post: jest.fn(),
  },
}))

describe('storyboardApis generation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('automatically confirms the batch generation charge', async () => {
    jest
      .mocked(apiClient.post)
      .mockResolvedValueOnce({
        action: 'confirm_charge',
        message: '生成全部分镜将消耗AI豆，确认后系统将开始生成',
        billing_token: 'billing-token',
      })
      .mockResolvedValueOnce({
        action: 'charged_generate',
        task_uuid: 'task-uuid',
        message: '批量分镜视频生成任务已创建',
      })

    const response = await storyboardApis.generateAllVideos({ task_id: 12, script_id: 12 })

    expect(apiClient.post).toHaveBeenNthCalledWith(
      1,
      '/aigc-video/api/v2/storyboard-videos/generate-all',
      {
        task_id: 12,
        script_id: 12,
        support_charge_confirmation: true,
      }
    )
    expect(apiClient.post).toHaveBeenNthCalledWith(
      2,
      '/aigc-video/api/v2/storyboard-videos/generate-all',
      {
        task_id: 12,
        script_id: 12,
        support_charge_confirmation: true,
        confirm_charge: true,
        billing_token: 'billing-token',
      }
    )
    expect(response).toMatchObject({ action: 'charged_generate', task_uuid: 'task-uuid' })
  })

  it('returns an insufficient-credit response without a second request', async () => {
    jest.mocked(apiClient.post).mockResolvedValueOnce({
      action: 'insufficient_credits',
      message: 'AI豆不足',
    })

    const response = await storyboardApis.generateSingleVideo({
      storyboard_id: 21,
      task_id: 12,
      script_id: 12,
    })

    expect(apiClient.post).toHaveBeenCalledTimes(1)
    expect(response).toEqual({ action: 'insufficient_credits', message: 'AI豆不足' })
  })
})
