import { getCodeCommentPreviewRightBoundary } from './conversationViewportBoundary'
import { useMemo } from 'react'
import { isElectronRuntime } from '@/lib/runtime-environment'
import type { UserMessageServices } from '@wegent/collaboration/conversation'
import { useAttachmentImageServices } from './useAttachmentImageServices'
import {
  getDesktopComposerEditorServices,
  desktopComposerTransferServices,
} from './composer/desktopComposerServices'
import { resolveComposerMentionBrandIconUrl } from './composer/composerMentions'
import { openLocalFile } from '@/lib/local-terminal'
import { buildPluginDetailRoute } from '@/features/plugins/pluginNavigation'
import { navigateTo } from '@/lib/navigation'

async function openLocalAttachmentPath(
  path: string,
  onOpenFile?: (path: string) => void
): Promise<void> {
  try {
    await openLocalFile(path)
  } catch (error) {
    if (onOpenFile) {
      onOpenFile(path)
      return
    }
    console.error('Failed to open local attachment:', error)
  }
}

export function useDesktopUserMessageServices(): UserMessageServices {
  const images = useAttachmentImageServices()
  const electron = isElectronRuntime()
  return useMemo(
    () => ({
      images,
      editor: { ...getDesktopComposerEditorServices(), preserveNativeEmptyCaret: !electron },
      transfers: desktopComposerTransferServices,
      resolveMentionIconUrl: resolveComposerMentionBrandIconUrl,
      onOpenPlugin: reference => navigateTo(buildPluginDetailRoute(reference)),
      openLocalAttachment: openLocalAttachmentPath,
      getCommentPreviewRightBoundary: getCodeCommentPreviewRightBoundary,
    }),
    [images, electron]
  )
}
