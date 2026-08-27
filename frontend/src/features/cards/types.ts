// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CardBlock } from '@/features/tasks/components/message/thinking/types'

export interface CardRendererProps {
  block: CardBlock
  taskId?: number
  subtaskId?: number
  onChatButtonClick?: (message: string) => void | Promise<void>
}

export interface VideoDirectorCardButton {
  button_id?: string
  button_name?: string
  button_type?: string
  url?: string
  link?: string
}

export interface VideoDirectorCardData {
  title?: string
  created_time?: string
  link?: string
  preview_type?: string
  preview_content?: {
    text?: string
  }
  buttons?: VideoDirectorCardButton[]
  video_url?: string
  cover_url?: string
  duration?: number
}

export interface VideoDirectorCardPreview {
  progress?: number
  progress_text?: string
  title?: string
  video_url?: string
  cover_url?: string
}
