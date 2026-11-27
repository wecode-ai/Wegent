import { TextInputDialog } from '@/components/common/TextInputDialog'

import { LocalProjectEditDialog } from '@/components/projects/LocalProjectEditDialog'
import { getRuntimeProjectOwner } from '@/lib/runtime-project-state'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import { AppReleaseNotesDialog } from '@/features/app-update/AppReleaseNotesDialog'

import { StandaloneFolderProjectDialog } from '@/components/projects/StandaloneProjectDialogs'

import { runtimeProjectUiId } from '@/lib/runtime-project'

import { ArchiveConversationsConfirmDialog } from './DesktopSidebarWidgets'

import type { useDesktopSidebarModel } from './useDesktopSidebarModel'
export function DesktopSidebarReleaseNotesDialog({
  installedReleaseNotes,
  setReleaseNotesDialogOpen,
  releaseNotesDialogOpen,
}: ReturnType<typeof useDesktopSidebarModel>['releaseNotesDialog']) {
  return (
    <>
      {installedReleaseNotes && (
        <AppReleaseNotesDialog
          open={releaseNotesDialogOpen}
          releaseNotes={installedReleaseNotes}
          onClose={() => setReleaseNotesDialogOpen(false)}
        />
      )}
    </>
  )
}
export function DesktopSidebarStandaloneDialog({
  devices,
  setStandaloneWorkspaceDialogMode,
  standaloneWorkspaceDialogMode,
  standaloneRemoteDialogIntent,
  preferredDeviceId,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onCloneGitRepository,
  onOpenStandaloneWorkspace,
  onRefreshDevices,
}: ReturnType<typeof useDesktopSidebarModel>['standaloneDialog']) {
  return (
    <>
      <StandaloneFolderProjectDialog
        key={standaloneWorkspaceDialogMode ?? 'standalone-folder-closed'}
        open={standaloneWorkspaceDialogMode !== null}
        mode={standaloneWorkspaceDialogMode ?? 'existing'}
        remoteIntent={standaloneRemoteDialogIntent}
        devices={devices}
        preferredDeviceId={preferredDeviceId}
        onClose={() => setStandaloneWorkspaceDialogMode(null)}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onCloneGitRepository={onCloneGitRepository}
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
        onRefreshDevices={onRefreshDevices}
      />
    </>
  )
}
export function DesktopSidebarArchiveDialogs({
  t,
  priorityArchiveItems,
  closePriorityArchiveDialog,
  runPriorityArchive,
  priorityForceArchiveItems,
  closePriorityForceArchiveDialog,
  archiveSectionMode,
  archiveSectionDialogCount,
  archiveSectionDialogTestId,
  closeArchiveSectionDialog,
  confirmArchiveSectionConversations,
  forceArchiveSectionMode,
  forceArchiveSectionDialogTestId,
  closeForceArchiveSectionDialog,
  confirmForceArchiveSectionConversations,
}: ReturnType<typeof useDesktopSidebarModel>['archiveDialogs']) {
  return (
    <>
      {priorityArchiveItems !== null && (
        <ArchiveConversationsConfirmDialog
          open
          title={t('workbench.priority_filter_archive_title', {
            defaultValue: '归档 {{count}} 个优先级任务？',
            count: priorityArchiveItems?.length ?? 0,
          })}
          description={t(
            'workbench.priority_filter_archive_description',
            '只会归档“优先级”分组中的任务，不会归档最近任务'
          )}
          confirmLabel={t('workbench.archive_project_dialog_confirm', '全部归档')}
          cancelLabel={t('workbench.cancel', '取消')}
          testId="runtime-priority-archive-dialog"
          onClose={closePriorityArchiveDialog}
          onConfirm={() => void runPriorityArchive(priorityArchiveItems)}
        />
      )}
      {priorityForceArchiveItems !== null && (
        <ArchiveConversationsConfirmDialog
          open
          title={t('workbench.archive_runtime_task_dirty_worktree_title')}
          description={t('workbench.archive_runtime_tasks_dirty_worktree_force_desc')}
          confirmLabel={t('workbench.archive_runtime_task_force_confirm')}
          cancelLabel={t('workbench.cancel', '取消')}
          testId="runtime-priority-force-archive-dialog"
          onClose={closePriorityForceArchiveDialog}
          onConfirm={() => void runPriorityArchive(priorityForceArchiveItems, { force: true })}
        />
      )}
      {archiveSectionMode !== null && (
        <ArchiveConversationsConfirmDialog
          open
          title={t(
            archiveSectionMode === 'chats'
              ? 'workbench.archive_chats_dialog_title'
              : 'workbench.archive_projects_dialog_title',
            {
              defaultValue: '归档 {{count}} 个对话?',
              count: archiveSectionDialogCount,
            }
          )}
          description={t(
            archiveSectionMode === 'chats'
              ? 'workbench.archive_chats_dialog_desc'
              : 'workbench.archive_projects_dialog_desc',
            {
              defaultValue:
                archiveSectionMode === 'chats'
                  ? '这会将对话列表中的对话归档。之后你可以在已归档对话中找到它们'
                  : '这会将项目中的对话归档。之后你可以在已归档对话中找到它们',
            }
          )}
          confirmLabel={t('workbench.archive_project_dialog_confirm', '全部归档')}
          cancelLabel={t('workbench.cancel', '取消')}
          testId={archiveSectionDialogTestId}
          onClose={closeArchiveSectionDialog}
          onConfirm={confirmArchiveSectionConversations}
        />
      )}
      {forceArchiveSectionMode !== null && (
        <ArchiveConversationsConfirmDialog
          open
          title={t('workbench.archive_runtime_task_dirty_worktree_title')}
          description={t('workbench.archive_runtime_tasks_dirty_worktree_force_desc')}
          confirmLabel={t('workbench.archive_runtime_task_force_confirm')}
          cancelLabel={t('workbench.cancel', '取消')}
          testId={forceArchiveSectionDialogTestId}
          onClose={closeForceArchiveSectionDialog}
          onConfirm={confirmForceArchiveSectionConversations}
        />
      )}
    </>
  )
}
export function DesktopSidebarProjectEditDialogs({
  t,
  devices,
  onRemoveProject,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  renamingProject,
  setRenamingProject,
  onUpdateProjectName,
  editingLocalProject,
  editingProjectWork,
  projectSpaceApis,
  experimentalFeaturesEnabled,
  models,
  editingProjectPluginApi,
  setEditingLocalProject,
  onUpdateLocalRuntimeProject,
}: ReturnType<typeof useDesktopSidebarModel>['projectEditDialogs']) {
  return (
    <>
      <TextInputDialog
        open={renamingProject !== null}
        title={t('workbench.rename_project', '重命名项目')}
        label={t('workbench.project_name', '项目名称')}
        initialValue={renamingProject?.name ?? ''}
        confirmLabel={t('workbench.save', '保存')}
        cancelLabel={t('workbench.cancel', '取消')}
        inputTestId="rename-project-input"
        confirmTestId="confirm-rename-project-button"
        onClose={() => setRenamingProject(null)}
        onSubmit={name =>
          renamingProject ? onUpdateProjectName(renamingProject.id, name) : Promise.resolve()
        }
      />
      <LocalProjectEditDialog
        open={editingLocalProject !== null}
        projectWork={editingProjectWork}
        device={findWorkbenchDevice(
          devices,
          editingProjectWork ? getRuntimeProjectOwner(editingProjectWork).deviceId : null
        )}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        projectSpaceApis={experimentalFeaturesEnabled ? projectSpaceApis : undefined}
        models={models}
        pluginApi={editingProjectPluginApi}
        onClose={() => setEditingLocalProject(null)}
        onSave={data =>
          onUpdateLocalRuntimeProject
            ? onUpdateLocalRuntimeProject(data)
            : Promise.reject(new Error('Local project editing is unavailable'))
        }
        onDelete={() => {
          if (!editingLocalProject) return
          const projectId = runtimeProjectUiId(editingLocalProject.project)
          setEditingLocalProject(null)
          void onRemoveProject(projectId)
        }}
      />
    </>
  )
}
