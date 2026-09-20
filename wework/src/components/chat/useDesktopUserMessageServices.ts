import { getCodeCommentPreviewRightBoundary } from './conversationViewportBoundary'
import { useContext, useEffect, useMemo, useState } from 'react'
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
import { WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useComposerCatalogBinding } from './composer/ComposerCatalogContext'
import type { LocalDeviceSkill } from '@/types/api'

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

export function useDesktopUserMessageServices(hasSkillReferences = false): UserMessageServices {
  const images = useAttachmentImageServices()
  const electron = isElectronRuntime()
  const pane = useContext(WorkbenchPaneContext)
  const catalog = useComposerCatalogBinding()
  const listSkills = catalog.listSkills ?? pane?.projectChat.listLocalSkills
  const [loaded, setLoaded] = useState<{
    source: typeof listSkills
    skills: LocalDeviceSkill[]
  } | null>(null)
  useEffect(() => {
    if (!hasSkillReferences || !listSkills) return
    let revision = 0
    const refresh = () => {
      const request = ++revision
      setLoaded(null)
      void listSkills().then(
        skills => {
          if (request === revision) setLoaded({ source: listSkills, skills })
        },
        () => {
          if (request === revision) setLoaded({ source: listSkills, skills: [] })
        }
      )
    }
    refresh()
    const event = catalog.catalogEvents.catalogChanged
    if (event) window.addEventListener(event, refresh)
    return () => {
      revision++
      if (event) window.removeEventListener(event, refresh)
    }
  }, [catalog.catalogEvents.catalogChanged, hasSkillReferences, listSkills])
  const localSkills = loaded?.source === listSkills ? loaded?.skills : undefined
  return useMemo(
    () => ({
      localSkills,
      images,
      editor: { ...getDesktopComposerEditorServices(), preserveNativeEmptyCaret: !electron },
      transfers: desktopComposerTransferServices,
      resolveMentionIconUrl: resolveComposerMentionBrandIconUrl,
      onOpenPlugin: reference => navigateTo(buildPluginDetailRoute(reference)),
      openLocalAttachment: openLocalAttachmentPath,
      getCommentPreviewRightBoundary: getCodeCommentPreviewRightBoundary,
    }),
    [images, electron, localSkills]
  )
}
