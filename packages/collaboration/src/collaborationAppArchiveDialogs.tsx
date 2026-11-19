import { IssueArchiveDialog, IssueArchiveDrawer } from './issue-archive'
import type { useCollaborationAppState } from './useCollaborationAppState'
import type { CollaborationIssue } from './types'
import type { createCollaborationTranslator } from './i18n'

type ArchiveInput = Pick<
  ReturnType<typeof useCollaborationAppState>,
  | 'archiveIssueTargets'
  | 'archiveIssueBusy'
  | 'archiveIssueError'
  | 'archiveDrawerOpen'
  | 'archivedIssues'
  | 'archiveNextCursor'
  | 'archiveDrawerLoading'
  | 'archiveDrawerError'
  | 'restoringIssueId'
  | 'confirmIssueArchive'
  | 'closeIssueArchive'
  | 'loadArchivedIssues'
  | 'closeArchiveDrawer'
  | 'restoreArchivedIssue'
> & { issues: CollaborationIssue[]; translate: ReturnType<typeof createCollaborationTranslator> }

export function renderCollaborationAppArchiveDialogs({
  archiveIssueTargets,
  archiveIssueBusy,
  archiveIssueError,
  archiveDrawerOpen,
  archivedIssues,
  archiveNextCursor,
  archiveDrawerLoading,
  archiveDrawerError,
  restoringIssueId,
  confirmIssueArchive,
  closeIssueArchive,
  loadArchivedIssues,
  closeArchiveDrawer,
  restoreArchivedIssue,
  issues,
  translate,
}: ArchiveInput) {
  return (
    <>
      {archiveIssueTargets?.length ? (
        <IssueArchiveDialog
          busy={archiveIssueBusy}
          count={archiveIssueTargets.length}
          error={archiveIssueError}
          hasChildren={issues.some(candidate => candidate.parent_id === archiveIssueTargets[0]?.id)}
          onCancel={closeIssueArchive}
          onConfirm={() => void confirmIssueArchive()}
          title={archiveIssueTargets[0]?.title}
          translate={translate}
        />
      ) : null}
      {archiveDrawerOpen ? (
        <IssueArchiveDrawer
          busyId={restoringIssueId}
          error={archiveDrawerError}
          items={archivedIssues}
          loading={archiveDrawerLoading}
          nextCursor={archiveNextCursor}
          onClose={closeArchiveDrawer}
          onLoadMore={() => void loadArchivedIssues(archiveNextCursor)}
          onRestore={issue => void restoreArchivedIssue(issue)}
          translate={translate}
        />
      ) : null}
    </>
  )
}
