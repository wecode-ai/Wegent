import {
  canAssignCollaborationIssue,
  type CollaborationIssue,
  type CollaborationMember,
  type ProjectAssistantRosterEntry,
} from '@wegent/collaboration'
import type { ExperienceSource } from './data/useExperienceSources'
import { projectScopeOf, type ExperienceProjectScope } from './model'

export function selectableExperienceIssueMember(member: CollaborationMember) {
  return member.can_be_assignee ?? member.role !== 'Viewer'
}

interface Submission {
  source: ExperienceSource
  targetId: string
  title: string
  summary: string
  riskLevel?: 'high' | 'low'
  selectedRoster?: ProjectAssistantRosterEntry[]
  dueDate: string
  assignee: string
  standalone: boolean
  viewerId: number
  nativeOwnerId?: number
  sourceCurrent(): boolean
  messages: { sourceUnavailable: string; permissionDenied: string; assigneeUnavailable: string }
  onCreated(scope: ExperienceProjectScope, issue: CollaborationIssue): void
}

/** The form's visible mutation state also owns admission and completion publication. */
export function createExperienceIssueSubmission() {
  let snapshot: { pending: boolean; error: string | null } = { pending: false, error: null }
  let intent: { id: string; fingerprint: string } | null = null
  let revision = 0
  const listeners = new Set<() => void>()
  const publish = (next: typeof snapshot) => {
    snapshot = next
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          revision++
          snapshot = { pending: false, error: null }
        }
      }
    },
    clearIntent: () => {
      intent = null
    },
    clearError: () => publish({ ...snapshot, error: null }),
    async submit(input: Submission) {
      if (snapshot.pending || !listeners.size) return
      const current = ++revision
      const isCurrent = () => current === revision && listeners.size > 0 && input.sourceCurrent()
      publish({ pending: true, error: null })
      try {
        const { source, targetId, messages } = input
        const [project, members] = await Promise.all([
          source.api.projects.get(targetId),
          source.api.members.list(targetId),
        ])
        if (!isCurrent()) return
        if (project.id !== targetId || project.project_store !== source.store)
          throw new Error(messages.sourceUnavailable)
        if (!canAssignCollaborationIssue(project)) throw new Error(messages.permissionDenied)
        const assigneeUserId =
          input.assignee === 'self'
            ? source.store === 'local'
              ? input.nativeOwnerId
              : (project.current_user_id ?? input.viewerId)
            : members.find(
                member =>
                  String(member.user_id) === input.assignee &&
                  selectableExperienceIssueMember(member)
              )?.user_id
        if (assigneeUserId === undefined) throw new Error(messages.assigneeUnavailable)
        const selectedRoster = input.selectedRoster ?? []
        let issue: CollaborationIssue
        if (
          selectedRoster.length > 0 &&
          source.store === 'backend' &&
          source.api.projects.createAssistantDispatch
        ) {
          const fingerprint = JSON.stringify([
            input.title.trim(),
            input.summary.trim(),
            input.dueDate,
            input.riskLevel,
            input.assignee,
            selectedRoster.map(entry => entry.id),
          ])
          const intentId = intent?.fingerprint === fingerprint ? intent.id : crypto.randomUUID()
          intent = { id: intentId, fingerprint }
          const dispatch = await source.api.projects.createAssistantDispatch(project.id, {
            intentId,
            goal: input.title.trim(),
            riskLevel: input.riskLevel ?? 'high',
            description: input.summary.trim(),
            ...(input.dueDate ? { dueAt: input.dueDate } : {}),
            managerUserId: assigneeUserId,
            confirmationState: 'confirmed',
            assignments: selectedRoster.map(entry => ({
              rosterEntryId: entry.id,
              userId: entry.userId,
              brief: input.summary.trim() || input.title.trim(),
            })),
          })
          issue = await source.api.issues.get(dispatch.rootIssueId)
        } else {
          issue = await source.api.issues.create(project.id, {
            title: input.title.trim(),
            description: input.summary.trim(),
            assigneeUserId,
            ...(input.dueDate ? { dueAt: input.dueDate } : {}),
            ...(input.standalone && input.assignee === 'self' ? { personalTask: true } : {}),
          })
        }
        if (isCurrent()) input.onCreated(projectScopeOf(project), issue)
      } catch (cause) {
        if (isCurrent())
          publish({ pending: true, error: cause instanceof Error ? cause.message : String(cause) })
      } finally {
        if (current === revision && listeners.size) publish({ ...snapshot, pending: false })
      }
    },
  }
}
