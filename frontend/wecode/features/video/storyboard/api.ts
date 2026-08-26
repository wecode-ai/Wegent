// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Storyboard API - 分镜相关接口
 */

import { apiClient } from '@/apis/client'
import { getToken } from '@/apis/user'
import type {
  Storyboard,
  StoryboardListResponse,
  StoryboardUpdateData,
  TaskStatusResponse,
  VideoClip,
  StoryboardVideoVersion,
  SingleVideoGenerateResponse,
  GenerateSingleVideoParams,
  GenerateAllVideosParams,
} from './types'

export type {
  Storyboard,
  StoryboardListResponse,
  StoryboardUpdateData,
  TaskStatusResponse,
  VideoClip,
  StoryboardVideoVersion,
  SingleVideoGenerateResponse,
  GenerateSingleVideoParams,
  GenerateAllVideosParams,
}

// Request options type for share_token support
type RequestOptions = {
  shareToken?: string
}

// Helper to build query string with share_token parameter
const buildQueryString = (baseUrl: string, options?: RequestOptions): string => {
  if (options?.shareToken) {
    const separator = baseUrl.includes('?') ? '&' : '?'
    return `${baseUrl}${separator}share_token=${encodeURIComponent(options.shareToken)}`
  }
  return baseUrl
}

async function startVideoGeneration(
  path: string,
  params: GenerateSingleVideoParams | GenerateAllVideosParams
): Promise<SingleVideoGenerateResponse> {
  const response = await apiClient.post<SingleVideoGenerateResponse>(path, {
    ...params,
    support_charge_confirmation: true,
  })
  if (response.action !== 'confirm_charge') return response

  return apiClient.post(path, {
    ...params,
    support_charge_confirmation: true,
    confirm_charge: true,
    billing_token: response.billing_token,
  })
}

export const storyboardApis = {
  // 获取剧本的所有分镜
  async getStoryboards(
    scriptId: number,
    options?: RequestOptions
  ): Promise<StoryboardListResponse> {
    return apiClient.get(
      buildQueryString(
        `/aigc-video/api/v2/storyboards/${scriptId}?include_video_versions=1`,
        options
      )
    )
  },

  // 通过任务ID获取分镜列表
  async getStoryboardsByTask(
    taskId: number,
    options?: RequestOptions
  ): Promise<StoryboardListResponse & { task_id: number }> {
    return apiClient.get(
      buildQueryString(`/aigc-video/api/v2/storyboards/task/${taskId}/storyboards`, options)
    )
  },

  // 获取单个分镜详情
  async getStoryboardDetail(id: number, options?: RequestOptions): Promise<Storyboard> {
    return apiClient.get(buildQueryString(`/aigc-video/api/v2/storyboards/${id}/detail`, options))
  },

  // 更新分镜
  // autoRegenerate: true（默认）- visual 变化时会自动触发首帧重新生成
  // autoRegenerate: false - 只保存，不触发首帧重新生成
  async updateStoryboard(
    id: number,
    data: StoryboardUpdateData,
    autoRegenerate: boolean = true
  ): Promise<{ task_uuid: string; message: string; created_at: string }> {
    return apiClient.put(
      `/aigc-video/api/v2/storyboards/${id}?auto_regenerate=${autoRegenerate}`,
      data
    )
  },

  // 重新生成分镜图片
  async regenerateStoryboardImage(
    id: number,
    force: boolean = false
  ): Promise<{ task_uuid: string; message: string; created_at: string }> {
    return apiClient.post(`/aigc-video/api/v2/storyboards/${id}/regenerate?force=${force}`)
  },

  // 查询任务状态
  async getTaskStatus(taskUuid: string): Promise<TaskStatusResponse> {
    return apiClient.get(`/aigc-video/api/v2/storyboards/task/${taskUuid}`)
  },

  // 批量生成分镜图片
  async generateStoryboards(
    scriptId: number
  ): Promise<{ task_uuid: string; message: string; created_at: string }> {
    return apiClient.post('/aigc-video/api/v2/storyboards/generate', { script_id: scriptId })
  },

  // 单分镜视频生成
  async generateSingleVideo(
    params: GenerateSingleVideoParams
  ): Promise<SingleVideoGenerateResponse> {
    return startVideoGeneration('/aigc-video/api/v2/storyboard-videos/generate-single', params)
  },

  async generateAllVideos(params: GenerateAllVideosParams): Promise<SingleVideoGenerateResponse> {
    return startVideoGeneration('/aigc-video/api/v2/storyboard-videos/generate-all', params)
  },

  // 查询视频生成任务状态（支持批量和单分镜）
  async getVideoTaskStatus(taskUuid: string, shotId?: string): Promise<TaskStatusResponse> {
    const url = shotId
      ? `/aigc-video/api/v2/storyboard-videos/task/${taskUuid}?shot_id=${encodeURIComponent(shotId)}`
      : `/aigc-video/api/v2/storyboard-videos/task/${taskUuid}`
    return apiClient.get(url)
  },

  async updateStoryboardVideoSelection(scriptId: number, storyboardId: number, clipId: number) {
    return apiClient.put('/aigc-video/api/v2/storyboard-videos/selection', {
      script_id: scriptId,
      storyboard_id: storyboardId,
      clip_id: clipId,
    })
  },

  // 替换分镜视频（上传+保存一步完成）
  async replaceVideo(
    storyboardId: number,
    file: File
  ): Promise<{ id: number; message: string; video_clip: VideoClip }> {
    const token = getToken()
    const formData = new FormData()
    formData.append('file', file)
    const response = await fetch(`/api/aigc-video/v2/storyboards/${storyboardId}/replace-video`, {
      method: 'POST',
      headers: { ...(token && { Authorization: `Bearer ${token}` }) },
      body: formData,
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.detail || '替换视频失败')
    }
    return response.json()
  },

  // 替换分镜图片（上传+保存一步完成）
  async replaceImage(
    storyboardId: number,
    file: File
  ): Promise<{
    id: number
    message: string
    image_pid: string
    image_url: string
    update_time: string
  }> {
    const token = getToken()
    const formData = new FormData()
    formData.append('file', file)
    const response = await fetch(`/api/aigc-video/v2/storyboards/${storyboardId}/replace-image`, {
      method: 'POST',
      headers: { ...(token && { Authorization: `Bearer ${token}` }) },
      body: formData,
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.detail || '替换图片失败')
    }
    return response.json()
  },
}
