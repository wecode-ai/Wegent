import { useLayoutEffect, useMemo, useRef } from 'react'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { User } from '@/types/api'
import { TemplateDialog } from '@wegent/collaboration/templates'
import { groupWorkContainer } from '@/api/groupWorkContainer'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { ThreadCreationHome } from '@/features/collaboration/ThreadCreationHome'
import type { GroupSource } from '@/features/collaboration/CollaborationGroupsSurface'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { createLocalWorkspaceApi } from './localWorkspaceApi'

/** Public work information is reviewed in the shared form; private prompts are never defaults. */
export function TaskOriginThreadCreateDialog({
  target,
  projects,
  services,
  user,
  scopeKey,
  onClose,
  onCreated,
}: {
  target?: CloudProject
  projects: CloudProject[]
  services: WorkbenchServices
  user: Pick<User, 'id' | 'user_name' | 'email'> | null
  scopeKey: string
  onClose(): void
  onCreated(item: CloudLoopItem, owner: CloudProject): Promise<void>
}) {
  const { t, i18n } = useTranslation('collaboration')
  const cloud = useOptionalCloudConnection()
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'zh-CN'
  const localIdentity = services.localParticipationIdentity
  const displayUserId = user?.id ?? localIdentity?.nativeOwnerUserId ?? 0
  const displayUserName = user?.user_name ?? localIdentity?.currentUser.user_name ?? t('you')
  const displayEmail = user?.email ?? null
  // Native IPC always authorizes the local owner; catalog labels do not grant authority.
  const local = useMemo(
    () =>
      createLocalWorkspaceApi(
        services.projectSpaceApis?.local,
        displayUserId,
        displayUserName,
        displayEmail,
        services.projectSpaceDetailServices?.local,
        locale
      ),
    [
      services.projectSpaceApis?.local,
      services.projectSpaceDetailServices?.local,
      displayUserId,
      displayUserName,
      displayEmail,
      locale,
    ]
  )
  const localGroups = services.chatGroupApis?.local
  const cloudGroups = services.chatGroupApis?.cloud
  const cloudWorkspace = services.sharedWorkspaceApi
  const sources = useMemo(() => {
    const values: GroupSource[] = []
    if (local && localGroups) values.push({ store: 'local', groups: localGroups, workspace: local })
    if (cloud.isConnected && cloudWorkspace && cloudGroups)
      values.push({
        store: 'cloud',
        groups: cloudGroups,
        workspace: cloudWorkspace,
      })
    return values
  }, [local, cloud.isConnected, cloudWorkspace, localGroups, cloudGroups])
  const live = useRef<{ scopeKey: string; services: WorkbenchServices } | null>({
    scopeKey,
    services,
  })
  useLayoutEffect(() => {
    live.current = { scopeKey, services }
    return () => {
      live.current = null
    }
  }, [scopeKey, services])
  const initialTarget = target
    ? {
        store: target.project_store === 'local' ? ('local' as const) : ('cloud' as const),
        ...(target.resource_type === 'chat_group'
          ? { groupId: target.id }
          : { projectId: target.id }),
      }
    : undefined
  return (
    <ThreadCreationHome
      key={scopeKey}
      sources={sources}
      projects={projects.filter(project => project.resource_type !== 'chat_group')}
      locale={locale}
      accountScope={scopeKey}
      draftScope={`task-origin:${scopeKey}`}
      initialTarget={initialTarget}
      onCancel={onClose}
      renderTargetPicker={content => (
        <TemplateDialog
          title={t('newThread')}
          description={t('threadHomeHint')}
          closeLabel={t('close')}
          onClose={onClose}
        >
          {content}
        </TemplateDialog>
      )}
      onCreated={async (created, store) => {
        const api = services.projectSpaceApis?.[store]
        const groups = services.chatGroupApis?.[store]
        const current = () =>
          live.current?.scopeKey === scopeKey &&
          live.current.services.projectSpaceApis?.[store] === api &&
          live.current.services.chatGroupApis?.[store] === groups
        if (!current()) return
        if (!api || !groups || !created.group_id) throw new Error(t('threadLinkUnavailable'))
        const [item, info] = await Promise.all([
          api.getLoopItem(created.id),
          groups.get(created.group_id),
        ])
        if (!current()) return
        if (
          item.id !== created.id ||
          item.group_id !== created.group_id ||
          item.cloud_project_id !== created.group_id ||
          info.group.id !== created.group_id
        )
          throw new Error(t('threadLinkUnavailable'))
        await onCreated(item, groupWorkContainer(info.group, store))
      }}
    />
  )
}
