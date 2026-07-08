import i18n from '@/i18n'
import { requestLocalExecutor } from '@/tauri/localExecutor'
import type { NormalizedRuntimeMessage, RuntimeTranscriptResponse } from '@/types/api'
import type { RuntimeTaskReminderItem } from './runtimeTaskReminders'

export interface RuntimeTaskNotificationText {
  title: string
  body: string
}

const NOTIFICATION_TEXT_MAX_CHARS = 160

function normalizedPreview(value: string | null | undefined): string {
  return (value ?? '').split(/\s+/).filter(Boolean).join(' ').trim()
}

function truncatePreview(value: string): string {
  const normalized = normalizedPreview(value)
  if (normalized.length <= NOTIFICATION_TEXT_MAX_CHARS) return normalized
  return `${normalized.slice(0, NOTIFICATION_TEXT_MAX_CHARS - 1)}…`
}

function textFromMessage(message: NormalizedRuntimeMessage): string {
  const content = normalizedPreview(message.content)
  if (content) return content

  const blocks = Array.isArray(message.blocks) ? message.blocks : []
  return normalizedPreview(
    blocks
      .filter(block => block.type === 'text')
      .map(block => {
        if (typeof block.content === 'string') return block.content
        return ''
      })
      .filter(Boolean)
      .join('\n')
  )
}

export function notificationTextFromMessages(
  messages: NormalizedRuntimeMessage[]
): RuntimeTaskNotificationText | null {
  for (let userIndex = messages.length - 1; userIndex >= 0; userIndex -= 1) {
    const userMessage = messages[userIndex]
    if (!userMessage || !userMessage.role?.toLowerCase().startsWith('user')) continue

    const prompt = truncatePreview(textFromMessage(userMessage))
    if (!prompt) continue

    const assistant = messages
      .slice(userIndex + 1)
      .reverse()
      .find(message => message.role?.toLowerCase().startsWith('assistant'))
    const reply = assistant ? truncatePreview(textFromMessage(assistant)) : ''

    return {
      title: prompt,
      body: reply || fallbackNotificationBody(),
    }
  }

  return null
}

export function fallbackNotificationText(
  item: RuntimeTaskReminderItem
): RuntimeTaskNotificationText {
  const taskTitle = truncatePreview(item.task.title) || fallbackNotificationTitle()
  const context = truncatePreview(item.projectName || item.workspace.workspacePath)

  return {
    title: taskTitle,
    body: context || fallbackNotificationBody(),
  }
}

export async function getRuntimeTaskNotificationText(
  item: RuntimeTaskReminderItem
): Promise<RuntimeTaskNotificationText> {
  try {
    const transcript = await requestLocalExecutor<RuntimeTranscriptResponse>(
      'runtime.tasks.transcript',
      {
        ...item.address,
        limit: 20,
        refresh: true,
      }
    )
    return notificationTextFromMessages(transcript.messages) ?? fallbackNotificationText(item)
  } catch (error) {
    console.error('[Wework] Failed to load task completion notification content', error)
    return fallbackNotificationText(item)
  }
}

function fallbackNotificationTitle(): string {
  const language = i18n.resolvedLanguage || i18n.language
  return language?.toLowerCase().startsWith('en') ? 'Task completed' : '任务已完成'
}

function fallbackNotificationBody(): string {
  const language = i18n.resolvedLanguage || i18n.language
  return language?.toLowerCase().startsWith('en') ? 'Model reply is ready' : '模型回复已完成'
}
