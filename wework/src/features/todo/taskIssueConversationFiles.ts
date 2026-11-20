import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { devicePathBasename, normalizeDevicePath } from '@wegent/chat-core/device-workspace-path'
import { readWorkspaceFileBytes, type ReadWorkspaceFileChunk } from '@/lib/workspace-file-bytes'
import { readElectronLocalFile } from '@/lib/electron-local-file'
import { buildConversationOutputs } from '@/features/dsh-runtime/conversationOutputs'
import {
  classifyMarkdownLink,
  extractMarkdownLinks,
} from '@/components/chat/assistantMarkdownLinks'
import { mimeTypeForFileName } from '@wegent/chat-core/workspace-file-types'

import type { TaskIssueConversationFile } from '@wegent/collaboration/platform'
export type { TaskIssueConversationFile } from '@wegent/collaboration/platform'

export function taskIssueConversationFiles(
  messages: WorkbenchMessage[],
  address: { deviceId: string; workspacePath?: string | null },
  readChunk: ReadWorkspaceFileChunk | undefined,
  fetchAttachment: (id: number) => Promise<Blob>
): TaskIssueConversationFile[] {
  const files = new Map<string, TaskIssueConversationFile>()
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      const { id, filename, local_path, workspace_file, mime_type } = attachment
      if (!(workspace_file && readChunk) && !local_path && id <= 0) continue
      const key = local_path ? `path:${local_path}` : `attachment:${id}`
      files.set(key, {
        id: key,
        name: filename,
        async load() {
          const content =
            workspace_file && readChunk
              ? await readWorkspaceFileBytes(workspace_file, readChunk)
              : local_path
                ? await readElectronLocalFile(local_path)
                : await fetchAttachment(id)
          return new File([content], filename, { type: mime_type })
        },
      })
    }
  }
  const workspacePath = address.workspacePath
  if (!workspacePath || !readChunk) return [...files.values()]
  const root = normalizeDevicePath(workspacePath)
  const prefix = root.endsWith('/') ? root : `${root}/`
  const paths = new Set(
    buildConversationOutputs(messages).outputs.flatMap(({ resource }) =>
      resource.kind === 'file' ? [resource.path] : []
    )
  )
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const link of extractMarkdownLinks(message.content)) {
      const target = classifyMarkdownLink(link.href)
      if (
        target.kind === 'file' &&
        !target.isDirectory &&
        mimeTypeForFileName(target.path).startsWith('image/')
      )
        paths.add(target.path)
    }
  }
  for (const outputPath of paths) {
    let path: string
    try {
      path = normalizeDevicePath(outputPath)
    } catch {
      continue
    }
    const relative = /^(\/|[a-zA-Z]:\/)/.test(path)
      ? path.startsWith(prefix)
        ? path.slice(prefix.length)
        : ''
      : path
    if (!relative || path === root) continue
    const key = `path:${prefix}${relative}`
    if (files.has(key)) continue
    const name = devicePathBasename(relative)
    files.set(key, {
      id: key,
      name,
      async load() {
        const bytes = await readWorkspaceFileBytes(
          { device_id: address.deviceId, workspace_path: root, path: relative },
          readChunk
        )
        return new File([bytes], name)
      },
    })
  }
  return [...files.values()]
}
