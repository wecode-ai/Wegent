import { visibleRuntimeUserMessage } from '@/lib/runtime-user-message'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import type {
  ProcessingBlock,
  RuntimeConversationItem,
  RuntimePaneTranscript,
} from '@/types/workbench'
import { findRuntimeTask } from '@/features/workbench/workbenchRuntimeHelpers'
import type {
  WeworkConversationAssetChunk,
  WeworkConversationAssetChunkRequest,
  WeworkConversationBlock,
  WeworkConversationItem,
  WeworkConversationReference,
  WeworkConversationSnapshot,
} from '../../../dsh/app-wework/client'
import {
  isAbsoluteWorkspacePath,
  normalizeAbsoluteWorkspacePath,
} from '@/lib/workspace-file-contract'

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]\n]*)\]\(([^)\n]+)\)/g

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

export function conversationReferenceKey(reference: WeworkConversationReference): string {
  return `${reference.deviceId}\u0000${reference.taskId}\u0000${reference.workspacePath ?? ''}`
}

export function isConversationAssetRequestAuthorized(
  snapshot: WeworkConversationSnapshot,
  request: WeworkConversationAssetChunkRequest
): boolean {
  const path = request.path.trim()
  const workspacePath = request.workspacePath?.trim() || null
  if (!path || workspacePath !== (snapshot.reference.workspacePath?.trim() || null)) return false

  return snapshot.turns.some(turn =>
    turn.items.some(item => conversationItemContainsAsset(item, path))
  )
}

export function resolveConversationAssetPath(
  request: Pick<WeworkConversationAssetChunkRequest, 'path' | 'workspacePath'>
): string {
  const path = request.path.trim()
  if (isAbsoluteWorkspacePath(path)) {
    return normalizeAbsoluteWorkspacePath(path, 'Conversation asset path must be absolute')
  }
  const workspacePath = request.workspacePath?.trim()
  if (!workspacePath) {
    throw new Error('Conversation workspace is required for relative asset paths')
  }
  const root = normalizeAbsoluteWorkspacePath(
    workspacePath,
    'Conversation workspace path must be absolute'
  ).replace(/\/+$/, '')
  return normalizeAbsoluteWorkspacePath(
    `${root}/${path}`,
    'Conversation asset path could not be resolved'
  )
}

export async function readConversationAssetChunk(
  snapshot: WeworkConversationSnapshot,
  request: WeworkConversationAssetChunkRequest,
  readFileChunk: (
    request: Readonly<{ path: string; offset: number; length: number }>
  ) => Promise<WeworkConversationAssetChunk>
): Promise<WeworkConversationAssetChunk> {
  if (!isConversationAssetRequestAuthorized(snapshot, request)) {
    throw new Error('Conversation asset is not part of the exported conversation')
  }
  return readFileChunk({
    path: resolveConversationAssetPath(request),
    offset: request.offset,
    length: request.length,
  })
}

function conversationItemContainsAsset(item: WeworkConversationItem, path: string): boolean {
  if (item.type === 'user_message') {
    return (
      item.attachments.some(attachment =>
        [attachment.localPath, localPreviewPath(attachment.previewUrl)].some(
          candidate => candidate?.trim() === path
        )
      ) || markdownContainsLocalAsset(item.content, path)
    )
  }
  if (item.type === 'assistant_text') return markdownContainsLocalAsset(item.content, path)
  if ('content' in item.block) return markdownContainsLocalAsset(item.block.content, path)
  return false
}

function markdownContainsLocalAsset(content: string, path: string): boolean {
  return [...content.matchAll(MARKDOWN_IMAGE_PATTERN)].some(match => {
    const destination = splitMarkdownImageDestination(match[2])
    return localPreviewPath(destination)?.trim() === path
  })
}

function splitMarkdownImageDestination(rawHref: string): string {
  const href = rawHref.trim()
  if (href.startsWith('<')) {
    const closingBracket = href.indexOf('>')
    if (closingBracket > 0) return decodePath(href.slice(1, closingBracket))
  }
  return decodePath(href.match(/^(.*?)(\s+(?:"[^"]*"|'[^']*'))$/)?.[1]?.trim() ?? href)
}

function localPreviewPath(value: string | null | undefined): string | null {
  if (!value || /^(?:blob:|data:|https?:)/i.test(value)) return null
  if (/^\/(?:api\/)?attachments\/\d+\/download(?:[?#].*)?$/i.test(value)) return null
  if (value.startsWith('file://')) {
    try {
      const pathname = decodeURIComponent(new URL(value).pathname)
      return pathname.match(/^\/[a-z]:\//i) ? pathname.slice(1) : pathname
    } catch {
      return value
    }
  }
  return decodePath(value)
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
