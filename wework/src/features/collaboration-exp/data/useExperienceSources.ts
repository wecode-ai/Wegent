import { useMemo } from 'react'
import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'
import type { User } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createLocalWorkspaceApi } from '@/features/todo/localWorkspaceApi'
import { createWeworkPlatformApi } from '@/features/todo/weworkPlatformApi'
import { withExperienceProjectChat } from './withExperienceProjectChat'

export interface ExperienceSource {
  store: CollaborationProject['project_store']
  api: SharedWorkspaceApi
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
    const localApi = createWeworkPlatformApi(undefined, local)
    if (localApi)
      sources.push({
        store: 'local',
        api: withExperienceProjectChat(
          localApi,
          services.projectSpaceDetailServices?.local?.projectChatClient
        ),
      })
    const cloudApi = cloudConnected
      ? createWeworkPlatformApi(services.sharedWorkspaceApi, null)
      : null
    if (cloudApi)
      sources.push({
        store: 'backend',
        api: withExperienceProjectChat(
          cloudApi,
          services.projectSpaceDetailServices?.cloud?.projectChatClient
        ),
      })
    return sources
  }, [services, user, cloudConnected, locale])
}
