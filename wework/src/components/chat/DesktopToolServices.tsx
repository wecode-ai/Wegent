import { useMemo, type ReactNode } from 'react'
import { ToolInteractionServicesProvider } from '@wegent/collaboration/conversation'
import { MarkdownServicesProvider } from '@wegent/collaboration/markdown'
import {
  devicePathBasename,
  devicePathDirname,
  joinDevicePath,
  normalizeDevicePath,
} from '@/lib/device-workspace-path'
import { readWorkspaceFileBytes } from '@/lib/workspace-file-bytes'
import { navigateTo } from '@/lib/navigation'
import { track } from '@/telemetry/client'
import { DesktopConversationTranslation } from './DesktopConversationTranslation'
import { useDesktopMarkdownServices } from './useDesktopMarkdownServices'
import { useWorkspaceFileReader } from './WorkspaceFileReaderContext'

interface ToolImageTarget {
  deviceId: string
  workspacePath: string
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

const services = {
  openProxySettings: () => navigateTo('/settings/personal/proxy'),
  onOutputAction: (action: 'copy' | 'open_file') =>
    track('ai_output_action_completed', { action, source: 'chat' }),
}
export function DesktopToolServices({
  children,
  imageTarget,
}: {
  children: ReactNode
  imageTarget?: ToolImageTarget | null
}) {
  const markdown = useDesktopMarkdownServices()
  const readWorkspaceFileChunk = useWorkspaceFileReader()
  const deviceId = imageTarget?.deviceId
  const workspacePath = imageTarget?.workspacePath
  const toolServices = useMemo(() => {
    if (!deviceId || !workspacePath) return services
    return {
      ...services,
      readImageFile: async (path: string) => {
        if (!readWorkspaceFileChunk) throw new Error('Workspace file reader is unavailable')
        const root = normalizeDevicePath(workspacePath)
        const normalizedPath = normalizeDevicePath(path)
        const filePath = /^(\/|[a-zA-Z]:\/)/.test(normalizedPath)
          ? normalizedPath
          : joinDevicePath(root, normalizedPath)
        const bytes = await readWorkspaceFileBytes(
          {
            device_id: deviceId,
            workspace_path: devicePathDirname(filePath),
            path: devicePathBasename(filePath),
          },
          readWorkspaceFileChunk
        )
        const extension = filePath.split('.').pop()?.toLowerCase() ?? ''
        return new Blob([bytes], {
          type: IMAGE_MIME_TYPES[extension] ?? 'application/octet-stream',
        })
      },
    }
  }, [deviceId, workspacePath, readWorkspaceFileChunk])
  return (
    <DesktopConversationTranslation>
      <MarkdownServicesProvider value={markdown}>
        <ToolInteractionServicesProvider value={toolServices}>
          {children}
        </ToolInteractionServicesProvider>
      </MarkdownServicesProvider>
    </DesktopConversationTranslation>
  )
}
