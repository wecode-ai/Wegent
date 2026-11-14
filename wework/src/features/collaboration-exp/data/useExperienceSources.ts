import { useMemo } from 'react'
import type {
  CollaborationProject,
  IssueParticipationViewer,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { User } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createLocalWorkspaceApi } from '@/features/todo/localWorkspaceApi'
import { createWeworkPlatformApi } from '@/features/todo/weworkPlatformApi'
import { withExperienceProjectChat } from './withExperienceProjectChat'

export interface ExperienceSource {
  store: CollaborationProject['project_store']
  api: SharedWorkspaceApi
  participationViewer: IssueParticipationViewer
}

function withLocalParticipation(
  api: SharedWorkspaceApi,
  viewerIds: readonly number[]
): SharedWorkspaceApi {
  const myWork = api.myWork
  if (!myWork?.page) return api
  const page = myWork.page
  return {
    ...api,
    myWork: {
      ...myWork,
      async page(input) {
        if (!viewerIds.length) throw new Error('Local participation identity is unavailable')
        return page({ ...input, viewerIds })
      },
    },
  }
}

/** Catalogs have separate owners; a selected object always uses its declared store. */
export function useExperienceSources(
  services: WorkbenchServices,
  user: User | null,
  cloudConnected: boolean,
  locale: 'zh-CN' | 'en'
): ExperienceSource[] {
  return useMemo(() => {
    if (!user) return []
    const local = createLocalWorkspaceApi(
      services.projectSpaceApis?.local,
      Number(user.id),
      user.user_name,
      user.email ?? null,
      services.projectSpaceDetailServices?.local,
      locale
    )
    const sources: ExperienceSource[] = []
    const localViewerIds = services.localParticipationIdentity?.viewerUserIds ?? []
    const localApi = createWeworkPlatformApi(undefined, local)
    if (localApi)
      sources.push({
        store: 'local',
        participationViewer: localViewerIds,
        api: withExperienceProjectChat(
          withLocalParticipation(localApi, localViewerIds),
          services.projectSpaceDetailServices?.local?.projectChatClient
        ),
      })
    const cloudApi = cloudConnected
      ? createWeworkPlatformApi(services.sharedWorkspaceApi, null)
      : null
    if (cloudApi)
      sources.push({
        store: 'backend',
        participationViewer: Number(user.id),
        api: withExperienceProjectChat(
          cloudApi,
          services.projectSpaceDetailServices?.cloud?.projectChatClient
        ),
      })
    return sources
  }, [services, user, cloudConnected, locale])
}
