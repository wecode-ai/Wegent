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
import { useAttachmentPreview } from './useAttachmentPreview'
import { buildPluginDetailRoute } from '@/features/plugins/pluginNavigation'
import { navigateTo } from '@/lib/navigation'
import { WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useComposerCatalogBinding } from './composer/ComposerCatalogContext'
import type { LocalDeviceSkill } from '@/types/api'
import { LOCAL_WORKBENCH_DEVICE_ALIAS, resolveLocalWorkbenchDeviceId } from '@/lib/workbench-device'
import { resolveHomeRelativeWorkspacePath } from '@/lib/workspace-paths'
import { useReferenceNavigation } from './useReferenceNavigation'

/** Builds the desktop services used to render and activate user-message references. */
export function useDesktopUserMessageServices(hasSkillReferences = false): UserMessageServices {
  const images = useAttachmentImageServices()
  const openAttachment = useAttachmentPreview()
  const electron = isElectronRuntime()
  const pane = useContext(WorkbenchPaneContext)
  const { openConversation, openIssue } = useReferenceNavigation()
  const catalog = useComposerCatalogBinding()
  const listSkills = catalog.listSkills ?? pane?.projectChat.listLocalSkills
  const getHomeDirectory = pane?.getDeviceHomeDirectory
  const localDeviceId = resolveLocalWorkbenchDeviceId(
    pane?.state.devices.filter(device => device.device_type === 'local') ?? [],
    LOCAL_WORKBENCH_DEVICE_ALIAS
  )!
  const [loaded, setLoaded] = useState<{
    source: typeof listSkills
    homeSource: typeof getHomeDirectory
    deviceId: string
    homeDirectory?: string
    skills: LocalDeviceSkill[]
  } | null>(null)
  useEffect(() => {
    if (!hasSkillReferences || !listSkills) return
    let revision = 0
    const refresh = () => {
      const request = ++revision
      setLoaded(null)
      const home = getHomeDirectory
        ? resolveHomeRelativeWorkspacePath('~/', localDeviceId, getHomeDirectory).catch(
            () => undefined
          )
        : Promise.resolve(undefined)
      void Promise.all([listSkills(), home]).then(
        ([skills, homeDirectory]) => {
          if (request === revision) {
            setLoaded({
              source: listSkills,
              homeSource: getHomeDirectory,
              deviceId: localDeviceId,
              skills,
              homeDirectory,
            })
          }
        },
        () => {
          if (request === revision) {
            setLoaded({
              source: listSkills,
              homeSource: getHomeDirectory,
              deviceId: localDeviceId,
              skills: [],
            })
          }
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
  }, [
    catalog.catalogEvents.catalogChanged,
    hasSkillReferences,
    listSkills,
    getHomeDirectory,
    localDeviceId,
  ])
  const current =
    loaded?.source === listSkills &&
    loaded?.homeSource === getHomeDirectory &&
    loaded?.deviceId === localDeviceId
      ? loaded
      : null
  const localSkills = current?.skills
  const localSkillHomeDirectory = current?.homeDirectory
  return useMemo(
    () => ({
      localSkills,
      localSkillHomeDirectory,
      images,
      editor: { ...getDesktopComposerEditorServices(), preserveNativeEmptyCaret: !electron },
      transfers: desktopComposerTransferServices,
      resolveMentionIconUrl: resolveComposerMentionBrandIconUrl,
      onOpenPlugin: reference => navigateTo(buildPluginDetailRoute(reference)),
      onOpenConversation: openConversation,
      onOpenIssue: openIssue,
      openAttachment: openAttachment ?? undefined,
      getCommentPreviewRightBoundary: getCodeCommentPreviewRightBoundary,
    }),
    [
      images,
      electron,
      localSkills,
      localSkillHomeDirectory,
      openAttachment,
      openConversation,
      openIssue,
    ]
  )
}
