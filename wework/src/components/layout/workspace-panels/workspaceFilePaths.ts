export * from '@wegent/chat-core/workspace-file-paths'

import {
  isAbsoluteWorkspacePath,
  normalizeAbsoluteWorkspacePath,
  normalizeWorkspaceSeparators,
} from '@/lib/workspace-file-contract'
import { workspaceParentPath } from '@wegent/chat-core/workspace-file-paths'

export function resolveMarkdownFilePath(documentPath: string, linkPath: string): string {
  const path = normalizeWorkspaceSeparators(linkPath, documentPath)
  return normalizeAbsoluteWorkspacePath(
    isAbsoluteWorkspacePath(path, documentPath)
      ? path
      : `${workspaceParentPath(documentPath).replace(/\/+$/, '')}/${path}`,
    'Markdown file path must be absolute'
  )
}
