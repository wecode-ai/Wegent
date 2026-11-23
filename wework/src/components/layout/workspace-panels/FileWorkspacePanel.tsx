import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  CodeCommentContext,
  WorkspaceFileApi,
  WorkspaceFileOpenRequest,
  WorkspaceTarget,
} from '@/types/workspace-files'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Code2, Eye, Folders, Loader2 } from 'lucide-react'
import { useCallback, useImperativeHandle, useMemo, useSyncExternalStore, type Ref } from 'react'
import { createFileWorkspacePanelState } from './fileWorkspacePanelState'
import { useWorkspaceMarkdownFileNavigation } from './useWorkspaceFileNavigation'
import { WorkspaceAttachmentPreview } from './WorkspaceAttachmentPreview'
import { WorkspaceFilePreview } from './WorkspaceFilePreview'
import { WorkspaceFileRootSelector, WorkspaceFileToolbar } from './WorkspaceFileToolbar'
import { WorkspaceFileTree } from './WorkspaceFileTree'
import { isPreviewableTextFile } from './workspaceFileTypes'

export interface FileWorkspacePanelSelection {
  path: string
  isDirectory: boolean
}

export interface FileWorkspacePanelProps {
  ref?: Ref<FileWorkspacePanelHandle>
  target: WorkspaceTarget | null
  workspaceTargets?: WorkspaceTarget[]
  workspaceFileApi: WorkspaceFileApi
  openFileRequest?: WorkspaceFileOpenRequest | null
  initialSelection?: FileWorkspacePanelSelection | null
  onAddCodeComment: (context: CodeCommentContext) => void
  onDirtyChange?: (dirty: boolean) => void
  onSelectionChange?: (selection: FileWorkspacePanelSelection) => void
  onSelectWorkspaceTarget?: (target: WorkspaceTarget) => void
  onOpenFileTab?: (target: WorkspaceTarget, path: string) => void
}

export interface FileWorkspacePanelHandle {
  navigate: (action: () => void) => void
}

export function FileWorkspacePanel({
  ref,
  target,
  workspaceTargets = [],
  workspaceFileApi,
  openFileRequest,
  initialSelection,
  onAddCodeComment,
  onDirtyChange,
  onSelectionChange,
  onSelectWorkspaceTarget,
  onOpenFileTab,
}: FileWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const targetDeviceId = target?.deviceId
  const targetPath = target?.path
  const targetSource = target?.source
  const targetTaskId = target?.taskId
  const targetWorkspaceSource = target?.workspaceSource
  const stableTarget = useMemo<WorkspaceTarget | null>(() => {
    if (!targetDeviceId || !targetPath || !targetSource) return null
    return {
      deviceId: targetDeviceId,
      path: targetPath,
      source: targetSource,
      taskId: targetTaskId,
      workspaceSource: targetWorkspaceSource,
    }
  }, [targetDeviceId, targetPath, targetSource, targetTaskId, targetWorkspaceSource])
  const rootPath = stableTarget?.path ?? ''
  const listWorkspaceEntries = workspaceFileApi.listWorkspaceEntries
  const readWorkspaceTextFile = workspaceFileApi.readWorkspaceTextFile
  const readWorkspaceFileChunk = workspaceFileApi.readWorkspaceFileChunk
  const writeWorkspaceTextFile = workspaceFileApi.writeWorkspaceTextFile
  const source = useMemo(
    () =>
      createFileWorkspacePanelState(stableTarget, {
        listWorkspaceEntries,
        readWorkspaceTextFile,
        readWorkspaceFileChunk,
        writeWorkspaceTextFile,
      }),
    [
      stableTarget,
      listWorkspaceEntries,
      readWorkspaceTextFile,
      readWorkspaceFileChunk,
      writeWorkspaceTextFile,
    ]
  )
  const subscribe = useCallback(
    (notify: () => void) =>
      source.subscribe(notify, {
        onDirtyChange,
        onSelectionChange,
        onOpenFileTab,
        initialSelection,
        openFileRequest,
        t,
      }),
    [source, onDirtyChange, onSelectionChange, onOpenFileTab, initialSelection, openFileRequest, t]
  )
  const {
    preview,
    editedContent,
    loadVersion,
    binaryPreview,
    previewLineTarget,
    previewLoading,
    previewTransitionVisible,
    previewLoadingProgress,
    previewError,
    editing,
    previewMode,
    saving,
    saveError,
    directoryTreeVisible,
    selectedFilePath,
    selectedPathIsDirectory,
    attachmentPreview,
    dirty,
    directory,
  } = useSyncExternalStore(subscribe, source.getSnapshot)
  const {
    activeDirectoryPath,
    entriesByPath,
    expandedPaths,
    loadingPaths,
    error: treeError,
  } = directory
  const { setPreviewMode, setEditing, setSaveError, navigate: navigateWithDirtyGuard } = source
  const { openFile: openMarkdownFile, navigationError } = useWorkspaceMarkdownFileNavigation({
    documentPath: preview?.path,
    onOpenFile: source.openFilePath,
    onOpenFileTab:
      stableTarget && onOpenFileTab ? path => onOpenFileTab(stableTarget, path) : undefined,
    navigateWithDirtyGuard,
  })
  const canEditPreview = Boolean(preview?.editable && writeWorkspaceTextFile)
  useImperativeHandle(ref, () => ({ navigate: navigateWithDirtyGuard }), [navigateWithDirtyGuard])
  useWindowEvent(
    'beforeunload',
    event => {
      event.preventDefault()
      event.returnValue = ''
    },
    { enabled: dirty }
  )

  if (attachmentPreview && openFileRequest?.attachment === attachmentPreview)
    return <WorkspaceAttachmentPreview key={openFileRequest?.id} source={attachmentPreview} />

  if (!stableTarget) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-text-muted">
        {t('workbench.workspace_file_no_workspace', '暂无可浏览的工作区')}
      </section>
    )
  }

  const activePreviewLineTarget =
    previewLineTarget && previewLineTarget.filePath === preview?.path ? previewLineTarget : null
  const displayPath = selectedFilePath ?? stableTarget.path
  const directoryTreeToggleLabel = directoryTreeVisible
    ? t('workbench.workspace_file_hide_tree')
    : t('workbench.workspace_file_show_tree')
  const retainedPreview = preview ?? binaryPreview
  const previewTransitioning =
    retainedPreview !== null &&
    selectedFilePath !== null &&
    retainedPreview.path !== selectedFilePath
  const displayedPreview =
    preview && canEditPreview && !editing ? { ...preview, content: editedContent } : preview

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="workspace-file-panel"
      data-workspace-device-id={stableTarget.deviceId}
    >
      <WorkspaceFileToolbar
        key={`${stableTarget.deviceId}:${displayPath}`}
        path={displayPath}
        isDirectory={selectedPathIsDirectory || !selectedFilePath}
        target={stableTarget}
        api={workspaceFileApi}
        textContent={
          preview?.path === displayPath && !preview.truncated
            ? canEditPreview
              ? editedContent
              : preview.content
            : undefined
        }
        canCopyContents={preview?.path === displayPath}
        onSelect={source.selectFile}
      >
        {previewTransitionVisible || (previewLoading && retainedPreview) || previewTransitioning ? (
          <span
            data-testid="workspace-file-preview-loading-indicator"
            className="flex h-4 w-4 items-center justify-center text-text-secondary"
          >
            <Loader2
              className="h-4 w-4 animate-spin"
              aria-label={t('workbench.workspace_file_preview_loading')}
            />
          </span>
        ) : null}
        {onSelectWorkspaceTarget && (
          <WorkspaceFileRootSelector
            targets={workspaceTargets}
            target={stableTarget}
            onSelect={target => navigateWithDirtyGuard(() => onSelectWorkspaceTarget(target))}
          />
        )}
        {preview && isPreviewableTextFile(preview.name) && (
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="workspace-file-markdown-mode-button"
            onClick={() => {
              const nextMode = previewMode === 'preview' ? 'source' : 'preview'
              setPreviewMode(nextMode)
              if (canEditPreview) setEditing(nextMode === 'source')
            }}
            className="flex h-11 min-w-11 items-center gap-1.5 rounded-md px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary md:h-8 md:min-w-0"
            aria-label={
              editing || previewMode === 'source'
                ? t('workbench.workspace_file_show_preview')
                : t('workbench.workspace_file_show_source')
            }
          >
            {editing || previewMode === 'source' ? (
              <Eye className="h-4 w-4" />
            ) : (
              <Code2 className="h-4 w-4" />
            )}
            {editing || previewMode === 'source'
              ? t('workbench.workspace_file_preview')
              : t('workbench.workspace_file_source')}
          </ControlButton>
        )}
        {canEditPreview && saving && (
          <span
            data-testid="workspace-file-saving-status"
            className="flex h-8 items-center gap-1.5 px-2 text-xs text-text-secondary"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('workbench.workspace_file_saving')}
          </span>
        )}
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="workspace-file-toggle-tree-button"
          aria-expanded={directoryTreeVisible}
          onClick={source.toggleTree}
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
          aria-label={directoryTreeToggleLabel}
          title={directoryTreeToggleLabel}
        >
          <Folders className="h-4 w-4" />
        </ControlButton>
      </WorkspaceFileToolbar>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <WorkspaceFilePreview
          onOpenFile={openMarkdownFile}
          file={displayedPreview}
          binaryFile={binaryPreview}
          loading={previewLoading}
          loadingProgress={previewLoadingProgress}
          error={previewError}
          onRetry={() => selectedFilePath && source.openFilePath(selectedFilePath)}
          targetLineStart={activePreviewLineTarget?.lineStart}
          targetLineEnd={activePreviewLineTarget?.lineEnd}
          onAddCodeComment={onAddCodeComment}
          editing={editing}
          editedContent={editedContent}
          loadVersion={loadVersion}
          onEditedContentChange={source.edit}
          onSave={() => void source.saveFile()}
          previewMode={previewMode}
        />
        <div
          data-testid="workspace-file-tree-container"
          className={cn(
            'min-h-0 shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-out',
            directoryTreeVisible ? 'w-[240px] opacity-100' : 'pointer-events-none w-0 opacity-0'
          )}
        >
          <WorkspaceFileTree
            visible={directoryTreeVisible}
            rootPath={rootPath}
            activeDirectoryPath={activeDirectoryPath}
            entriesByPath={entriesByPath}
            expandedPaths={expandedPaths}
            selectedPath={selectedFilePath}
            loadingPaths={loadingPaths}
            error={treeError}
            onOpenDirectory={source.openDirectory}
            onOpenFile={source.selectFile}
            onRefresh={source.refreshTree}
          />
        </div>
      </div>
      {navigationError && (
        <p
          role="alert"
          data-testid="workspace-file-navigation-error"
          className="px-4 py-2 text-sm text-destructive"
        >
          {t('workbench.workspace_file_preview_failed', '读取文件失败')}
        </p>
      )}
      {saveError && (
        <div
          data-testid="workspace-file-save-error"
          className="flex items-center justify-between gap-3 border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive wework:border-red-200 wework:bg-red-50 wework:text-red-700"
        >
          <span>{saveError}</span>
          {saveError.toLowerCase().includes('changed on disk') && selectedFilePath && (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="workspace-file-conflict-reload-button"
              className="shrink-0 underline"
              onClick={() => {
                source.reload()
              }}
            >
              {t('workbench.workspace_file_reload')}
            </ControlButton>
          )}
          {!saveError.toLowerCase().includes('changed on disk') && (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="workspace-file-save-retry-button"
              className="shrink-0 underline"
              onClick={() => {
                setSaveError(null)
                void source.saveFile()
              }}
            >
              {t('workbench.workspace_file_retry')}
            </ControlButton>
          )}
        </div>
      )}
    </div>
  )
}
