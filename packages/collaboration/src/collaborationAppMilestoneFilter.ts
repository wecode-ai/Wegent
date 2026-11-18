import type { useMilestoneFilter, MilestoneFilterProps } from './milestones/useMilestoneFilter'
import type { useCollaborationWorkspaceController } from './workspace-controller'

/** Share the shell's controlled selection and snapshot refresh with its milestone page. */
export function milestonePageProps(
  selection: ReturnType<typeof useMilestoneFilter>,
  projectId: string,
  commands: Pick<
    ReturnType<typeof useCollaborationWorkspaceController>['commands'],
    'loadProjectSnapshot'
  >
): MilestoneFilterProps & { onChanged(): Promise<unknown> } {
  return {
    filter: { milestoneId: selection.value === 'all' ? null : selection.value },
    onFilterChange: id => (id === null ? selection.clear() : selection.select(id)),
    onChanged: () => commands.loadProjectSnapshot(projectId, { invalidate: true }),
  }
}
