import type { MentionMenuRow } from './ComposerMentionMenu'
import type {
  ComposerMentionPresentation,
  ComposerExternalMentionPresentation,
  RuntimeWorkspaceSearchItem,
} from './workspaceMentionTypes'

export function createComposerMentionRows<
  C extends ComposerMentionPresentation,
  E extends ComposerExternalMentionPresentation,
>({
  open,
  mode,
  query,
  skillCandidates,
  candidates,
  contributedCandidates,
  externalCandidates,
  cloudProjectsOpen,
  cloudProjectScopeActive,
  cloudSpaceEnabled,
  cloudProjectCandidates,
  filteredCloudProjectCandidates,
  canSetGoal,
  canSetPlanMode,
  planModeActive,
  workspaceMatches,
}: {
  open: boolean
  mode?: 'skill' | 'mention' | 'slash'
  query: string
  skillCandidates: C[]
  candidates: C[]
  contributedCandidates: C[]
  externalCandidates: E[]
  cloudProjectsOpen: boolean
  cloudProjectScopeActive: boolean
  cloudSpaceEnabled: boolean
  cloudProjectCandidates: C[]
  filteredCloudProjectCandidates: C[]
  canSetGoal: boolean
  canSetPlanMode: boolean
  planModeActive: boolean
  workspaceMatches: RuntimeWorkspaceSearchItem[]
}): MentionMenuRow<C, E>[] {
  const candidateRows = (items: C[]): MentionMenuRow<C, E>[] =>
    items.map(candidate => ({ kind: 'candidate', candidate }))
  const externalRows: MentionMenuRow<C, E>[] = externalCandidates.map(candidate => ({
    kind: 'external',
    candidate,
  }))
  if (!open) return []
  if (mode === 'skill') return candidateRows(skillCandidates)
  if (!query.trim()) {
    if (cloudProjectsOpen && cloudProjectCandidates.length)
      return [{ kind: 'cloud-back-action' }, ...candidateRows(cloudProjectCandidates)]
    return [
      { kind: 'files-action' },
      ...candidateRows(contributedCandidates),
      ...externalRows,
      ...(canSetGoal ? [{ kind: 'goal-action' } as const] : []),
      ...(!planModeActive && canSetPlanMode ? [{ kind: 'plan-action' } as const] : []),
      ...(cloudSpaceEnabled ? [{ kind: 'cloud-space-direct-action' } as const] : []),
      ...(cloudSpaceEnabled && cloudProjectCandidates.length
        ? [{ kind: 'cloud-projects-action' } as const]
        : []),
      ...candidateRows(candidates.filter(candidate => candidate.kind !== 'cloud')),
    ]
  }
  if (cloudProjectScopeActive)
    return [{ kind: 'cloud-space-direct-action' }, ...candidateRows(filteredCloudProjectCandidates)]
  return [
    ...candidateRows(contributedCandidates),
    ...externalRows,
    ...candidateRows(candidates),
    ...workspaceMatches.map(item => ({ kind: 'path' as const, item })),
  ]
}
