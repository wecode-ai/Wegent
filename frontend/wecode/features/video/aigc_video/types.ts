// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface AigcVideoButton {
  button_id?: string
  button_name: string
  button_type?: 'chat' | 'link'
  prompt?: string
  link?: string
}

interface AigcVideoContentSection {
  type?: string
  value?: unknown
}

export interface AigcVideoCardData {
  title?: string
  created_time?: string
  link?: string
  preview_type?: 'script' | 'entity' | 'storyboard' | string
  preview_content?: { text?: string }
  progress_text?: string
  buttons?: AigcVideoButton[]
  content?: AigcVideoContentSection[]
  video_url?: string
  cover_url?: string
  duration?: number
}

export function parseAigcVideoCardData(value: Record<string, unknown>): AigcVideoCardData {
  const data = value as AigcVideoCardData
  if (Array.isArray(data.buttons) || !Array.isArray(data.content)) return data

  const buttons = data.content.flatMap(section => {
    if (section.type !== 'button' || !Array.isArray(section.value)) return []
    return section.value.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const button = item as Record<string, unknown>
      const buttonName = String(button.button_name || '').trim()
      if (!buttonName) return []
      return [
        {
          button_id: String(button.button_id || buttonName),
          button_name: buttonName,
          button_type: button.button_type === 'link' ? 'link' : 'chat',
          link: typeof button.link === 'string' ? button.link : undefined,
        } satisfies AigcVideoButton,
      ]
    })
  })

  return buttons.length > 0 ? { ...data, buttons } : data
}
