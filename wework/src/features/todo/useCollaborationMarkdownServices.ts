import { useMemo } from 'react'
import type { MarkdownServices } from '@wegent/collaboration/markdown'
import { useDesktopMarkdownServices } from '@/components/chat/useDesktopMarkdownServices'

export function useCollaborationMarkdownServices(): MarkdownServices {
  const desktopServices = useDesktopMarkdownServices()
  return useMemo(
    () => ({
      translate: desktopServices.translate,
      copyText: desktopServices.copyText,
      onCopy: desktopServices.onCopy,
      openExternalUrl: desktopServices.openExternalUrl,
      openAuthorizationUrl: desktopServices.openAuthorizationUrl,
      navigateTo: desktopServices.navigateTo,
      fetchAttachmentBlob: desktopServices.fetchAttachmentBlob,
      theme: desktopServices.theme,
      plantumlServerUrl: desktopServices.plantumlServerUrl,
    }),
    [desktopServices]
  )
}
