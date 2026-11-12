import type { CollaborationIssue, CollaborationProject } from '@wegent/collaboration'

export interface ThreadHierarchyRenderContext {
  item: CollaborationIssue
  classificationProject?: CollaborationProject
  requestLeave(action: () => void): void
}
