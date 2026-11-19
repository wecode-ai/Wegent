import type { ComposerCloudMentionCandidate } from '@/components/chat/composer/composerMentionCandidates'
import type { CloudProject, CloudLoopItem } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { useTranslation } from '@/hooks/useTranslation'
import { cloudLoopItemStatusLabel } from './workbenchCloudProjectContextModel'
export async function loadWorkbenchCloudMentions(
  project: CloudProject,
  composerTodoItem: CloudLoopItem | null,
  api: NonNullable<WorkbenchServices['deliveryApi']>,
  t: ReturnType<typeof useTranslation>['t']
) {
  const projectId = project.id
  const [files, items, deliveries] = await Promise.all([
    api.listCloudFiles(projectId),
    api.listLoopItems(projectId),
    composerTodoItem ? api.listDeliveries(composerTodoItem.id) : Promise.resolve({ items: [] }),
  ])
  const candidate = (
    key: string,
    title: string,
    description: string,
    reference: string,
    aliases: string[],
    statusLabel?: string
  ): ComposerCloudMentionCandidate => ({
    kind: 'cloud',
    key,
    title,
    description,
    metaLabel: t('workbench.mention_cloud_space', '云空间'),
    testId: key.replace(/[^a-zA-Z0-9_-]/g, '-'),
    enabled: true,
    reference,
    searchAliases: aliases,
    statusLabel,
  })
  return [
    candidate(
      `cloud-project:${projectId}`,
      t('workbench.mention_cloud_whole_space', '整个空间'),
      t('workbench.mention_cloud_whole_space_description', '共享文件 + 看板全部内容'),
      `[$${t('workbench.mention_cloud_whole_space', '整个空间')}](cloud://projects/${projectId})`,
      ['云项目', 'cloud', 'workspace']
    ),
    ...items.items.map(item =>
      candidate(
        `cloud-todo:${item.id}`,
        item.id,
        item.title,
        `[$${t('workbench.mention_cloud_todo_chip', '任务')}:${item.id}](cloud://projects/${projectId}/todos/${item.id})`,
        [item.title, item.status, 'TODO', '任务'],
        cloudLoopItemStatusLabel(item.status, t)
      )
    ),
    ...files.items.map(file =>
      candidate(
        `cloud-file:${file.id}`,
        file.name,
        file.path,
        `[$${file.name}](cloud://projects/${projectId}/files/${file.id})`,
        [file.path, file.kind, '文件', '目录']
      )
    ),
    ...deliveries.items.map(delivery =>
      candidate(
        `cloud-delivery:${delivery.id}`,
        `交付 ${delivery.id.slice(0, 8)}`,
        delivery.delivered_at ?? delivery.created_at,
        `[$交付 ${delivery.id.slice(0, 8)}](cloud://projects/${projectId}/deliveries/${delivery.id})`,
        ['交付', 'delivery', delivery.id]
      )
    ),
  ]
}
