import { visibleRuntimeUserMessage } from '@/lib/runtime-user-message'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import type {
  ProcessingBlock,
  RuntimeConversationItem,
  RuntimePaneTranscript,
} from '@/types/workbench'
import { findRuntimeTask } from '@/features/workbench/workbenchRuntimeHelpers'
import type {
  WeworkConversationBlock,
  WeworkConversationItem,
  WeworkConversationReference,
  WeworkConversationSnapshot,
} from '../../../dsh/app-wework/client'

type TranscriptLoader = (
  address: RuntimeTaskAddress,
  options: { includeFullContent: true }
) => Promise<RuntimePaneTranscript>

export async function loadDshConversationTranscript(
  reference: WeworkConversationReference,
  runtimeWork: RuntimeWorkListResponse | null,
  loadTranscript: TranscriptLoader
): Promise<WeworkConversationSnapshot> {
  const address: RuntimeTaskAddress = {
    deviceId: reference.deviceId,
    taskId: reference.taskId,
    workspacePath: reference.workspacePath,
  }
  const transcript = await loadTranscript(address, {
    includeFullContent: true,
  })
  const task = findRuntimeTask(runtimeWork, address)
  const title =
    task?.title?.trim() || firstVisibleUserMessage(transcript)?.slice(0, 60) || 'Conversation'

  return {
    reference: {
      deviceId: reference.deviceId,
      taskId: reference.taskId,
      workspacePath: reference.workspacePath ?? null,
    },
    title,
    complete: transcript.fullContent === true,
    turns: transcript.turns.map(turn => ({
      id: turn.id,
      status: turn.status,
      completedAt: turn.completedAt,
      items: turn.items.map(projectConversationItem),
    })),
  }
}

function firstVisibleUserMessage(transcript: RuntimePaneTranscript): string | null {
  for (const turn of transcript.turns) {
    for (const item of turn.items) {
      if (item.type === 'user_message') {
        const content = visibleRuntimeUserMessage(item.message.content)
        if (content) return content
      }
    }
  }
  return null
}

function projectConversationItem(item: RuntimeConversationItem): WeworkConversationItem {
  if (item.type === 'assistant_text') {
    return {
      id: item.id,
      type: 'assistant_text',
      content: item.content,
      createdAt: item.createdAt,
    }
  }
  if (item.type === 'block') {
    return {
      id: item.id,
      type: 'block',
      block: projectConversationBlock(item.block),
    }
  }
  return {
    id: item.id,
    type: 'user_message',
    content: visibleRuntimeUserMessage(item.message.content),
    createdAt: item.message.createdAt,
    status: item.message.runtimeStatus ?? item.message.status,
    attachments: (item.message.attachments ?? []).map(attachment => ({
      id: attachment.id,
      filename: attachment.filename,
      fileSize: attachment.file_size,
      mimeType: attachment.mime_type,
      localPath: attachment.local_path,
      previewUrl: attachment.local_preview_url,
    })),
  }
}

function projectConversationBlock(block: ProcessingBlock): WeworkConversationBlock {
  if (block.type === 'tool') {
    return {
      type: 'tool',
      toolName: block.toolName,
      toolInput: block.toolInput,
      toolOutput: block.toolOutput,
      status: block.status,
    }
  }
  if (block.type === 'file_changes') {
    return {
      type: 'file_changes',
      fileChanges: block.fileChanges,
      status: block.status,
    }
  }
  if (block.type === 'subagent') {
    const content =
      block.output?.trim() ||
      block.summary?.trim() ||
      block.description?.trim() ||
      block.title?.trim() ||
      ''
    return {
      type: 'text',
      content,
      status: block.status,
    }
  }
  return {
    type: block.type,
    content: block.content,
    status: block.status,
  }
}
