import { getCodeCommentPreviewRightBoundary } from './conversationViewportBoundary'
import { useContext, useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
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

const EMPTY_SKILLS: LocalDeviceSkill[] = []

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
  const catalogEvent = catalog.catalogEvents.catalogChanged
  const localDeviceId = resolveLocalWorkbenchDeviceId(
    pane?.state.devices.filter(device => device.device_type === 'local') ?? [],
    LOCAL_WORKBENCH_DEVICE_ALIAS
  )!
  const skillsResource = useMemo(
    () =>
      createAsyncResource<LocalDeviceSkill[]>(
        `message-skills/${localDeviceId}/${catalogEvent ?? ''}`,
        () => (listSkills ? listSkills() : Promise.resolve([])),
        { refreshOnSubscribe: true }
      ),
    [listSkills, localDeviceId, catalogEvent]
  )
  const homeResource = useMemo(
    () =>
      createAsyncResource(
        `message-skill-home/${localDeviceId}`,
        () =>
          getHomeDirectory
            ? resolveHomeRelativeWorkspacePath('~/', localDeviceId, getHomeDirectory)
            : Promise.resolve(undefined),
        { refreshOnSubscribe: true }
      ),
    [getHomeDirectory, localDeviceId]
  )
  const active = hasSkillReferences && !!listSkills
  const skillsQuery = useSyncExternalStore(
    active ? skillsResource.subscribe : subscribeIdleResource,
    skillsResource.getSnapshot,
    getIdleResourceSnapshot
  )
  const homeQuery = useSyncExternalStore(
    active && getHomeDirectory ? homeResource.subscribe : subscribeIdleResource,
    homeResource.getSnapshot,
    getIdleResourceSnapshot
  )
  useDOMEvent(
    'window',
    catalogEvent ?? '',
    () => {
      void skillsResource.reload()
      if (getHomeDirectory) void homeResource.reload()
    },
    { enabled: active && !!catalogEvent }
  )
  const localSkills =
    skillsQuery.data ?? (skillsQuery.status === 'error' ? EMPTY_SKILLS : undefined)
  const localSkillHomeDirectory = homeQuery.data
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
