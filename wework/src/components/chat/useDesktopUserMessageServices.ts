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
import { openLocalFileInWorkspaceApp } from '@/lib/local-terminal'
import { buildPluginDetailRoute } from '@/features/plugins/pluginNavigation'
import { navigateTo } from '@/lib/navigation'
import { WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useComposerCatalogBinding } from './composer/ComposerCatalogContext'
import type { LocalDeviceSkill } from '@/types/api'
import { LOCAL_WORKBENCH_DEVICE_ALIAS, resolveLocalWorkbenchDeviceId } from '@/lib/workbench-device'
import { resolveHomeRelativeWorkspacePath } from '@/lib/workspace-paths'

async function openLocalAttachmentPath(
  path: string,
  onOpenFile?: (path: string) => void,
  workspacePath?: string
): Promise<void> {
  try {
    await openLocalFileInWorkspaceApp(path, workspacePath)
  } catch (error) {
    if (onOpenFile) {
      onOpenFile(path)
      return
    }
    console.error('Failed to open local attachment:', error)
  }
}

export function useDesktopUserMessageServices(
  hasSkillReferences = false,
  workspacePath?: string
): UserMessageServices {
  const images = useAttachmentImageServices()
  const electron = isElectronRuntime()
  const pane = useContext(WorkbenchPaneContext)
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
      openLocalAttachment: (path, onOpenFile) =>
        openLocalAttachmentPath(path, onOpenFile, workspacePath),
      getCommentPreviewRightBoundary: getCodeCommentPreviewRightBoundary,
    }),
    [images, electron, localSkills, localSkillHomeDirectory, workspacePath]
  )
}
