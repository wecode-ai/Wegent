import { createCollaborationTranslator, IssueHierarchySummary } from '@wegent/collaboration'
import type { CollaborationIssue, CollaborationProject } from '@wegent/collaboration'
import type { ChatGroup } from '@/api/chatGroups'
import type { ThreadHierarchyRenderContext } from './threadHierarchy'

export function ThreadHierarchySection({
  context,
  group,
  items,
  locale,
  onOpenThread,
  onCreateChild,
}: {
  context: ThreadHierarchyRenderContext
  group: ChatGroup
  items: CollaborationIssue[]
  locale: 'zh-CN' | 'en'
  onOpenThread(id: string): void
  onCreateChild?(parent: CollaborationIssue, project?: CollaborationProject): void
}) {
  if (context.item.group_id !== group.id || context.item.cloud_project_id !== group.id) return null
  const editable =
    group.status === 'active' && ['Owner', 'Maintainer', 'Developer'].includes(group.role)
  return (
    <IssueHierarchySummary
      item={context.item}
      allItems={items}
      translate={createCollaborationTranslator(locale)}
      onOpen={related => onOpenThread(related.id)}
      onAddChild={
        editable && onCreateChild
          ? () =>
              context.requestLeave(() => onCreateChild(context.item, context.classificationProject))
          : undefined
      }
    />
  )
}
