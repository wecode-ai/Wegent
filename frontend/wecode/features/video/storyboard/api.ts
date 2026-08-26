// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import type {
  GenerateAllVideosParams,
  GenerateSingleVideoParams,
  Storyboard,
  StoryboardListResponse,
  StoryboardUpdateData,
  TaskStatusResponse,
  VideoClip,
  VideoGenerateResponse,
} from './types'

export const storyboardApis = {
  getStoryboards(scriptId: number): Promise<StoryboardListResponse> {
    return apiClient.get(`/aigc-video/api/v2/storyboards/${scriptId}?include_video_versions=1`)
  },

  getStoryboardDetail(id: number): Promise<Storyboard> {
    return apiClient.get(`/aigc-video/api/v2/storyboards/${id}/detail`)
  },

  updateStoryboard(
    id: number,
    data: StoryboardUpdateData,
    autoRegenerate = false
  ): Promise<{ task_uuid?: string; message: string; created_at?: string }> {
    return apiClient.put(
      `/aigc-video/api/v2/storyboards/${id}?auto_regenerate=${autoRegenerate}`,
      data
    )
  },

  regenerateStoryboardImage(
    id: number,
    force = false
  ): Promise<{ task_uuid: string; message: string; created_at: string }> {
    return apiClient.post(`/aigc-video/api/v2/storyboards/${id}/regenerate?force=${force}`)
  },

  getImageTaskStatus(taskUuid: string): Promise<TaskStatusResponse> {
    return apiClient.get(`/aigc-video/api/v2/storyboards/task/${taskUuid}`)
  },

  async generateSingleVideo(params: GenerateSingleVideoParams): Promise<VideoGenerateResponse> {
    const response = await apiClient.post<VideoGenerateResponse>(
      '/aigc-video/api/v2/storyboard-videos/generate-single',
      {
        ...params,
        support_charge_confirmation: true,
      }
    )
    if (response.action !== 'confirm_charge') return response

    return apiClient.post('/aigc-video/api/v2/storyboard-videos/generate-single', {
      ...params,
      support_charge_confirmation: true,
      confirm_charge: true,
      billing_token: response.billing_token,
    })
  },

  async generateAllVideos(params: GenerateAllVideosParams): Promise<VideoGenerateResponse> {
    const response = await apiClient.post<VideoGenerateResponse>(
      '/aigc-video/api/v2/storyboard-videos/generate-all',
      {
        ...params,
        support_charge_confirmation: true,
      }
    )
    if (response.action !== 'confirm_charge') return response

    return apiClient.post('/aigc-video/api/v2/storyboard-videos/generate-all', {
      ...params,
      support_charge_confirmation: true,
      confirm_charge: true,
      billing_token: response.billing_token,
    })
  },

  getVideoTaskStatus(taskUuid: string, shotId?: string): Promise<TaskStatusResponse> {
    const suffix = shotId ? `?shot_id=${encodeURIComponent(shotId)}` : ''
    return apiClient.get(`/aigc-video/api/v2/storyboard-videos/task/${taskUuid}${suffix}`)
  },

  updateVideoSelection(scriptId: number, storyboardId: number, clipId: number) {
    return apiClient.put('/aigc-video/api/v2/storyboard-videos/selection', {
      script_id: scriptId,
      storyboard_id: storyboardId,
      clip_id: clipId,
    })
  },

  replaceImage(storyboardId: number, file: File) {
    const form = new FormData()
    form.append('file', file)
    return apiClient.postForm<{
      id: number
      message: string
      image_pid: string
      image_url: string
    }>(`/aigc-video/v2/storyboards/${storyboardId}/replace-image`, form)
  },

  replaceVideo(storyboardId: number, file: File) {
    const form = new FormData()
    form.append('file', file)
    return apiClient.postForm<{ id: number; message: string; video_clip: VideoClip }>(
      `/aigc-video/v2/storyboards/${storyboardId}/replace-video`,
      form
    )
  },
}
