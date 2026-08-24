// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import type {
  MusicTaskStatusResponse,
  SaveCompositionRequest,
  SaveCompositionResponse,
  SubtitleTaskStatusResponse,
} from './types'

export const compositionApis = {
  generateMusic(data: { prompt: string; duration: number }) {
    return apiClient.post<{ task_uuid: string; message?: string }>(
      '/aigc-video/v2/scripts/bgm/generate',
      data
    )
  },

  getMusicTaskStatus(taskUuid: string): Promise<MusicTaskStatusResponse> {
    return apiClient.get(`/aigc-video/v2/scripts/bgm/task/${taskUuid}`)
  },

  saveComposition(data: SaveCompositionRequest): Promise<SaveCompositionResponse> {
    return apiClient.post('/aigc-video/v2/storyboard-videos/clips/update', data)
  },

  regenerateSubtitles(data: {
    clip_id: number
    script_id: number
    trim_start?: number
    trim_end?: number | null
    save_to_db?: boolean
  }) {
    return apiClient.post<{ task_uuid: string }>('/aigc-video/v2/clip-subtitles/regenerate', data)
  },

  getSubtitleTaskStatus(taskUuid: string): Promise<SubtitleTaskStatusResponse> {
    return apiClient.get(`/aigc-video/v2/clip-subtitles/task/${taskUuid}`)
  },

  updateFinalCover(scriptId: number, clipId: number, coverTime: number) {
    return apiClient.put<{
      clip_id: number
      cover_time_in_source: number
      cover_url?: string
      generation_status?: 'pending' | 'processing' | 'completed' | 'failed'
      message: string
    }>(`/aigc-video/v2/scripts/${scriptId}/final-cover`, {
      clip_id: clipId,
      cover_time_in_source: coverTime,
    })
  },

  removeFinalCover(scriptId: number) {
    return apiClient.delete<{ message: string }>(`/aigc-video/v2/scripts/${scriptId}/final-cover`)
  },
}
