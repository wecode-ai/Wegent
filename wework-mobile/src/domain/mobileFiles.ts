import {
  classifyMarkdownLink,
  getAuthenticatedAttachmentId,
  transformMarkdownUrl,
} from '../../../packages/collaboration/src/markdown/assistantMarkdownLinks'
import { resolveWorkspaceFilePath } from '../../../packages/chat-core/src/workspace-file-paths'
import type { MobileWorkspaceFileTarget } from './mobileFileTarget'
import type { MobileFileRequest } from '@/types/files'

export function mobileAttachmentRequest(
  href: string,
  apiBaseUrl: string
): MobileFileRequest | null {
  const url = new URL(href, apiBaseUrl)
  const id =
    url.origin === new URL(apiBaseUrl).origin ? getAuthenticatedAttachmentId(url.href) : null
  if (id === null) return null
  return {
    kind: 'attachment',
    attachment: {
      id,
      filename: `attachment-${id}`,
      file_size: 0,
      mime_type: 'application/octet-stream',
      status: 'ready',
      file_extension: '',
      created_at: '',
    },
  }
}

export function mobileFileKey(request: MobileFileRequest): string {
  switch (request.kind) {
    case 'workspace':
      return JSON.stringify(['workspace', request.target.deviceId, request.path])
    case 'attachment': {
      const reference = request.attachment.workspace_file
      return reference
        ? JSON.stringify([
            'workspace',
            reference.device_id,
            reference.workspace_path,
            reference.path,
          ])
        : JSON.stringify(['attachment', request.attachment.id])
    }
    case 'local':
      return JSON.stringify(['local', request.uri])
    case 'image':
      return JSON.stringify(['image', request.dataUri])
    case 'diff':
      return JSON.stringify([
        'diff',
        request.summary.device_id,
        request.summary.workspace_path,
        request.summary.artifact_id,
        request.path,
      ])
    case 'git-diff':
      return JSON.stringify([
        'git-diff',
        request.target.deviceId,
        request.target.path,
        request.selection.mode,
        request.path,
      ])
  }
}

export function resolveMobileFileLink(href: string, target: MobileWorkspaceFileTarget | null) {
  const safeUrl = transformMarkdownUrl(href, 'href')
  if (!safeUrl) return { kind: 'none' } as const
  const link = classifyMarkdownLink(safeUrl)
  if (link.kind === 'external') return { kind: 'external', url: safeUrl } as const
  if (link.kind !== 'file') return { kind: 'none' } as const
  if (!target) throw new Error('当前会话尚无可访问的文件目录')
  const path = resolveWorkspaceFilePath(target, link.path)
  if (!path) throw new Error('文件路径无效')
  return link.isDirectory
    ? ({ kind: 'directory', target: { ...target, path } } as const)
    : ({
        kind: 'file',
        request: {
          kind: 'workspace',
          target,
          path,
          lineStart: link.lineStart,
          lineEnd: link.lineEnd,
        } as MobileFileRequest,
      } as const)
}

export function mobileFileName(request: MobileFileRequest): string {
  if (request.kind === 'attachment') return request.attachment.filename
  if (request.kind === 'local' || request.kind === 'image') return request.name
  if (request.kind === 'diff' || request.kind === 'git-diff')
    return request.path?.split(/[\\/]/).at(-1) || '文件变更.diff'
  return request.path.split(/[\\/]/).at(-1) || request.path
}

export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
