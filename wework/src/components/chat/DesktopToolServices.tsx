import { useContext, useMemo, type ReactNode } from 'react'
import type { ToolBlock } from '@wegent/chat-core/runtime-conversation'
import type { RuntimeTaskAddress } from '@/types/api'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { McpAppsProvider, McpAppSlot } from '@/features/mcp-apps/McpAppsProvider'
import { useTranslation } from '@/hooks/useTranslation'
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
  mcpAppAddress,
}: {
  children: ReactNode
  imageTarget?: ToolImageTarget | null
  mcpAppAddress?: RuntimeTaskAddress | null
}) {
  const workbench = useContext(WorkbenchContext)
  const { t } = useTranslation('common')
  const markdown = useDesktopMarkdownServices()
  const readWorkspaceFileChunk = useWorkspaceFileReader()
  const deviceId = imageTarget?.deviceId
  const workspacePath = imageTarget?.workspacePath
  const toolServices = useMemo(() => {
    const api = workbench?.services.runtimeWorkApi
    const base = {
      ...services,
      renderMcpApp:
        mcpAppAddress && api?.requestMcpApp
          ? (block: ToolBlock) => <McpAppSlot key={block.id} block={block} />
          : undefined,
    }
    if (!deviceId || !workspacePath) return base
    return {
      ...base,
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
  }, [
    deviceId,
    workspacePath,
    readWorkspaceFileChunk,
    mcpAppAddress,
    workbench?.services.runtimeWorkApi,
  ])
  const api = workbench?.services.runtimeWorkApi
  const content =
    mcpAppAddress && api?.requestMcpApp ? (
      <McpAppsProvider
        key={`${mcpAppAddress.deviceId}:${mcpAppAddress.taskId}`}
        address={mcpAppAddress}
        api={{ requestMcpApp: api.requestMcpApp }}
        onMessage={async message => {
          const confirmation = await import('@/api/dsh/desktopHost').then(({ invokeDesktopHost }) =>
            invokeDesktopHost<{ response: number }>('dialog.message', {
              type: 'question',
              message,
              buttons: [t('mcp_apps.cancel'), t('mcp_apps.send')],
              defaultId: 0,
              cancelId: 0,
            })
          )
          if (confirmation.response !== 1) throw new Error('User declined the app message')
          const accepted = await workbench!.sendRuntimePaneMessage({
            address: mcpAppAddress,
            message,
          })
          if (!accepted) throw new Error('The conversation could not accept the app message')
        }}
      >
        {children}
      </McpAppsProvider>
    ) : (
      children
    )
  return (
    <DesktopConversationTranslation>
      <MarkdownServicesProvider value={markdown}>
        <ToolInteractionServicesProvider value={toolServices}>
          {content}
        </ToolInteractionServicesProvider>
      </MarkdownServicesProvider>
    </DesktopConversationTranslation>
  )
}
