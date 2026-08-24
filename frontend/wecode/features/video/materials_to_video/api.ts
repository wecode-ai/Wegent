// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from '@/apis/client'
import type {
  MaterialSearchResponse,
  MaterialTimelineResponse,
  MaterialTimelineTracks,
  NarrativeFrameworkResponse,
  VideoMaterialItem,
} from './types'

export const narrativeFrameworkApi = {
  get(sessionId: string, taskUuid: string): Promise<NarrativeFrameworkResponse> {
    return apiClient.get(
      `/aigc-video/v2/material-video-async/narration-framework/content?session_id=${encodeURIComponent(sessionId)}&task_uuid=${encodeURIComponent(taskUuid)}`
    )
  },

  update(
    sessionId: string,
    taskUuid: string,
    markdown: string,
    confirmed?: boolean
  ): Promise<NarrativeFrameworkResponse> {
    return apiClient.put('/aigc-video/v2/material-video-async/narration-framework/content', {
      session_id: sessionId,
      task_uuid: taskUuid,
      content: { markdown },
      ...(confirmed ? { confirmed: true } : {}),
    })
  },
}

export const materialSearchApi = {
  get(sessionId: string, taskUuid: string): Promise<MaterialSearchResponse> {
    return apiClient.get(
      `/aigc-video/v2/material-video-async/material-search/result?session_id=${encodeURIComponent(sessionId)}&task_uuid=${encodeURIComponent(taskUuid)}`
    )
  },

  confirm(
    sessionId: string,
    taskUuid: string,
    materials: VideoMaterialItem[]
  ): Promise<{ session_id: string; count: number; message: string }> {
    return apiClient.post('/aigc-video/v2/material-video-async/confirm-materials', {
      session_id: sessionId,
      task_uuid: taskUuid,
      materials,
    })
  },
}

export const materialTimelineApi = {
  get(sessionId: string): Promise<MaterialTimelineResponse> {
    return apiClient.get(`/aigc-video/v2/material-video/timelines/${encodeURIComponent(sessionId)}`)
  },

  update(sessionId: string, taskId: string, tracks: MaterialTimelineTracks) {
    return apiClient.post<{ session_id: string; task_id: string; message: string }>(
      '/aigc-video/v2/material-video/update-timeline',
      {
        session_id: sessionId,
        task_id: taskId,
        tracks,
      }
    )
  },

  openInOpenCut(
    sessionId: string,
    artifactId: string
  ): Promise<{ open_url: string; artifact_id?: string }> {
    return apiClient.get(
      `/aigc-video/material-video/opencut/open/${encodeURIComponent(sessionId)}?artifact_id=${encodeURIComponent(artifactId)}`
    )
  },
}
