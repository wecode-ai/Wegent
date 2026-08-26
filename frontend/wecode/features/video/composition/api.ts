// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Composition API - 剪辑工作台相关接口
 * Draft is built from storyboard data on the client side (no backend draft storage).
 * Only render and music APIs remain server-side.
 */

import { apiClient } from '@/apis/client'
import type {
  GenerateMusicRequest,
  GenerateMusicResponse,
  MusicTaskStatusResponse,
  RegenerateSubtitlesRequest,
  RegenerateSubtitlesResponse,
  RenderCompositionRequest,
  RenderCompositionResponse,
  SaveCompositionRequest,
  SaveCompositionResponse,
  SubtitleTaskStatusResponse,
} from './types'

// --- API object ---

export const compositionApis = {
  /**
   * Generate background music via /v2/scripts/bgm/generate.
   */
  async generateMusic(data: GenerateMusicRequest): Promise<GenerateMusicResponse> {
    return apiClient.post(`/aigc-video/v2/scripts/bgm/generate`, data)
  },

  /**
   * Get music generation task status via /v2/scripts/bgm/task/{task_uuid}.
   */
  async getMusicTaskStatus(taskUuid: string): Promise<MusicTaskStatusResponse> {
    return apiClient.get(`/aigc-video/v2/scripts/bgm/task/${taskUuid}`)
  },

  /**
   * Render final composition video.
   */
  async renderComposition(
    draftId: number,
    data: RenderCompositionRequest
  ): Promise<RenderCompositionResponse> {
    return apiClient.post(`/aigc-video/api/v2/compositions/${draftId}/render`, data)
  },

  /**
   * Get render task status.
   */
  async getRenderTaskStatus(taskUuid: string) {
    return apiClient.get(`/aigc-video/api/v2/compositions/render-tasks/${taskUuid}`)
  },

  /**
   * Save composition clip changes.
   */
  async saveComposition(
    _draftId: number,
    data: SaveCompositionRequest
  ): Promise<SaveCompositionResponse> {
    return apiClient.post(`/aigc-video/v2/storyboard-videos/clips/update`, data)
  },

  /**
   * Persist the final cover selection by clip and source time.
   */
  async updateFinalVideoCover(
    scriptId: number,
    data: { clip_id: number; cover_time_in_source: number }
  ): Promise<{
    script_id: number
    clip_id: number
    cover_time_in_source: number
    cover_url?: string
    updated_at?: string
    generation_status?: 'pending' | 'processing' | 'completed' | 'failed'
    generation_task_uuid?: string
    generation_error?: string
    message: string
  }> {
    return apiClient.put(`/aigc-video/v2/scripts/${scriptId}/final-cover`, data)
  },

  /**
   * Remove the final video cover for a script.
   */
  async removeFinalVideoCover(scriptId: number): Promise<{ message: string }> {
    return apiClient.delete(`/aigc-video/v2/scripts/${scriptId}/final-cover`)
  },

  /**
   * Regenerate subtitles for a clip via /v2/clip-subtitles/regenerate.
   */
  async regenerateSubtitles(
    data: RegenerateSubtitlesRequest
  ): Promise<RegenerateSubtitlesResponse> {
    return apiClient.post(`/aigc-video/v2/clip-subtitles/regenerate`, data)
  },

  /**
   * Get subtitle regeneration task status via /v2/clip-subtitles/task/{task_uuid}.
   */
  async getSubtitleTaskStatus(taskUuid: string): Promise<SubtitleTaskStatusResponse> {
    return apiClient.get(`/aigc-video/v2/clip-subtitles/task/${taskUuid}`)
  },
}
