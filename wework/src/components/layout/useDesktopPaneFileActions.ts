import { resolveWorkspaceFilePath } from './workspace-panels/workspaceFilePaths'
import { workspaceFileTabId } from './workspace-panels/workspaceFileTabs'
import { useCallback, useMemo } from 'react'
import { LOCAL_WORKBENCH_DEVICE_ALIAS, resolveLocalWorkbenchDeviceId } from '@/lib/workbench-device'
import { isAbsoluteWorkspacePath, resolveHomeRelativeWorkspacePath } from '@/lib/workspace-paths'
import {
  createLocalAttachmentWorkspaceTarget,
  createLocalFileWorkspaceTarget,
} from '@/lib/workspace-target'
import {
  applyProjectEnvironmentPatch,
  type EnvironmentDiffMode,
  type GitPatchAction,
} from '@/api/environment'
import type {
  WorkspaceAttachmentPreviewSource,
  WorkspaceFileOpenOptions,
  WorkspaceFileOpenRequest,
  WorkspaceTarget,
} from '@/types/workspace-files'
import {
  createFilePreviewTraceId,
  filePreviewElapsedMs,
  filePreviewPathMetadata,
  logFilePreviewDiagnostic,
  scheduleFilePreviewMainThreadProbe,
} from '@/lib/file-preview-diagnostics'
import { type RightWorkspacePanelTab } from './workspace-panels/RightWorkspacePanel'
import { getLocalPathKind } from '@/lib/local-terminal'
import {
  formatEnvironmentReviewErrorMessage,
  type DesktopReviewMetadata,
} from './desktopWorkbenchPaneTypes'
import { useWorkbenchPaneEnvironment } from './useWorkbenchPaneEnvironment'
import type { RuntimeTaskAddress } from '@/types/api'
import { getErrorMessage } from '@/lib/error-message'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { TFunction } from 'i18next'
import type {
  DesktopPaneWorkspaceState,
  DesktopPaneWorkspaceSnapshot,
} from './desktopPaneWorkspaceState'
import type { DesktopPaneWorkspaceSession } from './desktopPaneWorkspaceSession'
import type { WorkbenchPaneContextValue } from '@/features/workbench/workbenchContextTypes'
import type { Dispatch, SetStateAction } from 'react'

function rejectUnavailableDiff(message: string): Promise<never> {
  return Promise.reject(new Error(message))
}

interface Input {
  captureScope: DesktopPaneWorkspaceSession['captureScope']
  loadTurnFileChangesDiff: WorkbenchPaneContextValue['loadTurnFileChangesDiff']
  getDeviceHomeDirectory: WorkbenchPaneContextValue['getDeviceHomeDirectory']
  deviceApi: WorkbenchServices['deviceApi']
  t: TFunction<'common'>
  tChat: TFunction<'chat'>
  currentRuntimeTask: RuntimeTaskAddress | null
  setFileOpenError: Dispatch<SetStateAction<string | null>>
  workspaceProject: ReturnType<typeof useWorkbenchPaneEnvironment>['workspaceProject']
  workspaceTarget: ReturnType<typeof useWorkbenchPaneEnvironment>['workspaceTarget']
  environmentInfo: ReturnType<typeof useWorkbenchPaneEnvironment>['environmentInfo']
  refreshEnvironmentInfo: ReturnType<typeof useWorkbenchPaneEnvironment>['refreshEnvironmentInfo']
  loadEnvironmentDiff: ReturnType<typeof useWorkbenchPaneEnvironment>['loadEnvironmentDiff']
  devices: WorkbenchPaneContextValue['state']['devices']
  paneMessagesRef: DesktopPaneWorkspaceSession['resources']['paneMessagesRef']
  nextReviewRequest: DesktopPaneWorkspaceSession['nextReviewRequest']
  isReviewRequestCurrent: DesktopPaneWorkspaceSession['isReviewRequestCurrent']
  previousTurnReviewRef: DesktopPaneWorkspaceSession['resources']['previousTurnReviewRef']
  rightPanelOpen: boolean
  rightPanelView: DesktopPaneWorkspaceSnapshot['rightPanelView']
  rightPanelTabs: DesktopPaneWorkspaceSnapshot['rightPanelTabs']
  selectedWorkspaceFile: DesktopPaneWorkspaceSnapshot['selectedWorkspaceFile']
  reviewState: DesktopPaneWorkspaceSnapshot['reviewState']
  setSelectedFileWorkspaceTargetKey: DesktopPaneWorkspaceState['setSelectedFileWorkspaceTargetKey']
  setSelectedWorkspaceFile: DesktopPaneWorkspaceState['setSelectedWorkspaceFile']
  setFileTabs: DesktopPaneWorkspaceState['setFileTabs']
  setReviewState: DesktopPaneWorkspaceState['setReviewState']
  setOpenFileRequest: Dispatch<SetStateAction<WorkspaceFileOpenRequest | null>>
  hasPreviousTurnReview: boolean
  canBrowseFiles: boolean
  effectiveWorkspaceTarget: WorkspaceTarget | null
  fileWorkspaceTargets: WorkspaceTarget[]
  fileWorkspaceTarget: WorkspaceTarget | null
  latestPreviousTurnSubtaskId: string | null
  openRightPanelTab: (tab: RightWorkspacePanelTab) => void
}
export function useDesktopPaneFileActions({
  captureScope,
  loadTurnFileChangesDiff,
  getDeviceHomeDirectory,
  deviceApi,
  t,
  tChat,
  currentRuntimeTask,
  setFileOpenError,
  workspaceProject,
  workspaceTarget,
  environmentInfo,
  refreshEnvironmentInfo,
  loadEnvironmentDiff,
  devices,
  paneMessagesRef,
  nextReviewRequest,
  isReviewRequestCurrent,
  previousTurnReviewRef,
  rightPanelOpen,
  rightPanelView,
  rightPanelTabs,
  selectedWorkspaceFile,
  reviewState,
  setSelectedFileWorkspaceTargetKey,
  setSelectedWorkspaceFile,
  setFileTabs,
  setReviewState,
  setOpenFileRequest,
  hasPreviousTurnReview,
  canBrowseFiles,
  effectiveWorkspaceTarget,
  fileWorkspaceTargets,
  fileWorkspaceTarget,
  latestPreviousTurnSubtaskId,
  openRightPanelTab,
}: Input) {
  const openReviewFromDiffLoader = useCallback(
    async (loadDiff: () => Promise<string>, metadata: DesktopReviewMetadata = {}) => {
      const scope = captureScope()

      const requestId = nextReviewRequest()
      openRightPanelTab('review')
      setReviewState({
        loading: true,
        diff: '',
        error: undefined,
        reviewTitle: metadata.reviewTitle,
        reviewMode: metadata.reviewMode,
        defaultFileTreeVisible: metadata.defaultFileTreeVisible,
        branchName: metadata.branchName,
        targetBranchName: metadata.targetBranchName,
        focusFilePath: metadata.focusFilePath,
        sourceSubtaskId: metadata.sourceSubtaskId,
        reloadDiff: loadDiff,
      })
      try {
        const diff = await loadDiff()
        if (!scope.isCurrent()) return

        if (isReviewRequestCurrent(requestId)) {
          setReviewState({
            loading: false,
            diff,
            error: undefined,
            reviewTitle: metadata.reviewTitle,
            reviewMode: metadata.reviewMode,
            defaultFileTreeVisible: metadata.defaultFileTreeVisible,
            branchName: metadata.branchName,
            targetBranchName: metadata.targetBranchName,
            focusFilePath: metadata.focusFilePath,
            sourceSubtaskId: metadata.sourceSubtaskId,
            reloadDiff: loadDiff,
          })
        }
      } catch (error) {
        if (!scope.isCurrent()) return

        if (isReviewRequestCurrent(requestId)) {
          setReviewState({
            loading: false,
            diff: '',
            error: formatEnvironmentReviewErrorMessage({
              error,
              fallbackMessage: t('workbench.environment_review_failed'),
              deviceUnavailableMessage: t('workbench.environment_review_device_unavailable'),
            }),
            reviewTitle: metadata.reviewTitle,
            reviewMode: metadata.reviewMode,
            defaultFileTreeVisible: metadata.defaultFileTreeVisible,
            branchName: metadata.branchName,
            targetBranchName: metadata.targetBranchName,
            focusFilePath: metadata.focusFilePath,
            sourceSubtaskId: metadata.sourceSubtaskId,
            reloadDiff: loadDiff,
          })
        }
      }
    },
    [captureScope, openRightPanelTab, nextReviewRequest, isReviewRequestCurrent, setReviewState, t]
  )
  const openEnvironmentChangesReview = useCallback(
    async (mode: EnvironmentDiffMode = 'branch') => {
      // The review session retains its reload function across pane renders.
      const loadDiff =
        loadEnvironmentDiff && workspaceTarget
          ? loadEnvironmentDiff.bind(null, workspaceTarget, mode)
          : rejectUnavailableDiff.bind(null, t('workbench.environment_review_unavailable'))
      await openReviewFromDiffLoader(loadDiff, {
        reviewTitle: tChat(`file_changes.${mode}_label`),
        reviewMode: mode,
        branchName: environmentInfo.branchName,
      })
    },
    [
      environmentInfo.branchName,
      loadEnvironmentDiff,
      openReviewFromDiffLoader,
      t,
      tChat,
      workspaceTarget,
    ]
  )
  const openDefaultEnvironmentChangesReview = useCallback(() => {
    void openEnvironmentChangesReview()
  }, [openEnvironmentChangesReview])
  const selectReviewView = useCallback(() => {
    if (reviewState.diff || reviewState.loading) {
      openRightPanelTab('review')
      return
    }

    void openEnvironmentChangesReview()
  }, [openEnvironmentChangesReview, openRightPanelTab, reviewState.diff, reviewState.loading])
  const selectFilesView = useCallback(() => {
    if (!canBrowseFiles) return
    openRightPanelTab('files')
  }, [canBrowseFiles, openRightPanelTab])
  const selectFileWorkspaceTarget = useCallback(
    (target: WorkspaceTarget) => {
      setSelectedFileWorkspaceTargetKey(`${target.deviceId}:${target.path}`)
      setOpenFileRequest(null)
      openRightPanelTab('files')
    },
    [setOpenFileRequest, openRightPanelTab, setSelectedFileWorkspaceTargetKey]
  )
  const openFileTab = useCallback(
    (target: WorkspaceTarget, path: string, options?: WorkspaceFileOpenOptions) => {
      const tab = workspaceFileTabId(target, path)
      if (
        rightPanelTabs.includes('files') &&
        selectedWorkspaceFile &&
        !selectedWorkspaceFile.isDirectory &&
        workspaceFileTabId(selectedWorkspaceFile.target, selectedWorkspaceFile.path) === tab
      ) {
        if (options) {
          setOpenFileRequest(current => ({
            ...options,
            id: (current?.id ?? 0) + 1,
            path,
            target,
          }))
        }
        openRightPanelTab('files')
        return
      }
      setFileTabs(current => {
        const existing = current[tab]
        if (existing && !options) return current
        return {
          ...current,
          [tab]: {
            target,
            path,
            openRequest: options
              ? { ...options, id: (existing?.openRequest?.id ?? 0) + 1, path }
              : undefined,
          },
        }
      })
      openRightPanelTab(tab)
    },
    [openRightPanelTab, rightPanelTabs, selectedWorkspaceFile, setFileTabs, setOpenFileRequest]
  )
  const handleFileWorkspaceSelectionChange = useCallback(
    (selection: { path: string; isDirectory: boolean }) => {
      if (!fileWorkspaceTarget) return
      setSelectedWorkspaceFile({
        target: fileWorkspaceTarget,
        path: selection.path,
        isDirectory: selection.isDirectory,
      })
    },
    [fileWorkspaceTarget, setSelectedWorkspaceFile]
  )
  const openAttachment = useCallback(
    (attachment: WorkspaceAttachmentPreviewSource) => {
      setOpenFileRequest(current => ({
        id: (current?.id ?? 0) + 1,
        path: attachment.filename,
        target: current?.target,
        attachment,
      }))
      openRightPanelTab('files')
    },
    [openRightPanelTab, setOpenFileRequest]
  )

  const openWorkspaceFileFromMessage = useCallback(
    async (path: string, options?: WorkspaceFileOpenOptions) => {
      const scope = captureScope()

      setFileOpenError(null)
      try {
        const trimmedPath = await resolveHomeRelativeWorkspacePath(
          path.trim(),
          effectiveWorkspaceTarget?.deviceId ??
            resolveLocalWorkbenchDeviceId(devices, LOCAL_WORKBENCH_DEVICE_ALIAS)!,
          getDeviceHomeDirectory
        )
        if (!scope.isCurrent()) return

        if (!trimmedPath) return
        const traceId = createFilePreviewTraceId()
        const pathMetadata = filePreviewPathMetadata(trimmedPath)
        logFilePreviewDiagnostic(traceId, 'message_link_click', pathMetadata)
        scheduleFilePreviewMainThreadProbe(traceId, 'message_link_click')
        const attachmentTarget = createLocalAttachmentWorkspaceTarget(trimmedPath, devices)
        const absoluteLocalTarget = createLocalFileWorkspaceTarget(trimmedPath, devices, {
          workspaceTargets: fileWorkspaceTargets,
          pathStyleSource: workspaceTarget?.path,
        })
        let localTarget =
          attachmentTarget ??
          (absoluteLocalTarget &&
          (!effectiveWorkspaceTarget ||
            effectiveWorkspaceTarget.workspaceSource === 'local' ||
            effectiveWorkspaceTarget.deviceId === absoluteLocalTarget.deviceId)
            ? absoluteLocalTarget
            : null)
        let isDirectory = options?.isDirectory
        if (localTarget && isDirectory === undefined) {
          const statStartedAt = performance.now()
          logFilePreviewDiagnostic(traceId, 'filesystem_stat_start', pathMetadata)
          const kind = await getLocalPathKind(trimmedPath)
          // The exact local file is already resolved. Project and workspace
          // hydration can finish while the same conversation is still open.
          const workspaceScopeCurrent = scope.isCurrent()
          if (
            !workspaceScopeCurrent &&
            !(kind === 'file' && scope.isConversationCurrentOnDevice(localTarget.deviceId))
          ) {
            return
          }
          isDirectory = kind === 'directory'
          logFilePreviewDiagnostic(traceId, 'filesystem_stat_end', {
            ...pathMetadata,
            durationMs: filePreviewElapsedMs(statStartedAt),
            isDirectory,
            workspaceScopeCurrent,
          })
          scheduleFilePreviewMainThreadProbe(traceId, 'filesystem_stat_end')
        }
        if (localTarget && isDirectory) {
          localTarget = createLocalFileWorkspaceTarget(trimmedPath, devices, {
            workspaceTargets: attachmentTarget ? [] : fileWorkspaceTargets,
            isDirectory: true,
            pathStyleSource: workspaceTarget?.path,
          })
        }
        const target = localTarget ?? effectiveWorkspaceTarget
        if (target && !isDirectory) {
          const resolvedPath = resolveWorkspaceFilePath(target, trimmedPath)
          if (!resolvedPath) return
          openFileTab(target, resolvedPath, { ...options, isDirectory, traceId })
        } else {
          setOpenFileRequest(current => ({
            id: (current?.id ?? 0) + 1,
            path: trimmedPath,
            lineStart: options?.lineStart,
            lineEnd: options?.lineEnd,
            isDirectory,
            traceId,
            target: localTarget ?? undefined,
          }))
          openRightPanelTab('files')
        }
        logFilePreviewDiagnostic(traceId, 'open_file_request_queued', {
          ...pathMetadata,
          hasLocalTarget: Boolean(localTarget),
          isDirectory: isDirectory ?? null,
        })
        logFilePreviewDiagnostic(traceId, 'right_panel_open_requested')
        scheduleFilePreviewMainThreadProbe(traceId, 'right_panel_open_requested')
      } catch (error) {
        if (!scope.isCurrent()) return

        setFileOpenError(getErrorMessage(error, t('workbench.workspace_file_preview_failed')))
      }
    },
    [
      captureScope,
      setFileOpenError,
      effectiveWorkspaceTarget,
      devices,
      getDeviceHomeDirectory,
      fileWorkspaceTargets,
      openFileTab,
      workspaceTarget,
      setOpenFileRequest,
      openRightPanelTab,
      t,
    ]
  )
  const openLocalSkillFile = useCallback(
    async (path: string) => {
      const scope = captureScope()

      setFileOpenError(null)
      try {
        const trimmedPath = await resolveHomeRelativeWorkspacePath(
          path.trim(),
          resolveLocalWorkbenchDeviceId(devices, LOCAL_WORKBENCH_DEVICE_ALIAS)!,
          getDeviceHomeDirectory
        )
        if (!scope.isCurrent()) return

        if (!trimmedPath) return
        if (!isAbsoluteWorkspacePath(trimmedPath)) {
          await openWorkspaceFileFromMessage(trimmedPath)
          if (!scope.isCurrent()) return

          return
        }
        const target = createLocalFileWorkspaceTarget(trimmedPath, devices)
        if (!target) return

        setOpenFileRequest(current => ({
          id: (current?.id ?? 0) + 1,
          path: trimmedPath,
          target,
        }))
        openRightPanelTab('files')
      } catch (error) {
        if (!scope.isCurrent()) return

        setFileOpenError(getErrorMessage(error, t('workbench.workspace_file_preview_failed')))
      }
    },
    [
      captureScope,
      setFileOpenError,
      devices,
      getDeviceHomeDirectory,
      setOpenFileRequest,
      openRightPanelTab,
      openWorkspaceFileFromMessage,
      t,
    ]
  )
  const applyReviewPatch = useCallback(
    async (action: GitPatchAction, patch: string) => {
      const scope = captureScope()

      if (!deviceApi || !workspaceTarget) {
        throw new Error(t('workbench.environment_review_unavailable'))
      }
      await applyProjectEnvironmentPatch(
        deviceApi,
        workspaceProject,
        action,
        patch,
        workspaceTarget
      )
      if (!scope.isCurrent()) return

      if (reviewState.reloadDiff) {
        await openReviewFromDiffLoader(reviewState.reloadDiff, {
          reviewTitle: reviewState.reviewTitle,
          reviewMode: reviewState.reviewMode,
          defaultFileTreeVisible: reviewState.defaultFileTreeVisible,
          branchName: reviewState.branchName,
          targetBranchName: reviewState.targetBranchName,
          focusFilePath: reviewState.focusFilePath,
          sourceSubtaskId: reviewState.sourceSubtaskId,
        })
        if (!scope.isCurrent()) return
      }
      await refreshEnvironmentInfo()
      if (!scope.isCurrent()) return
    },
    [
      captureScope,
      deviceApi,
      workspaceTarget,
      workspaceProject,
      reviewState.reloadDiff,
      reviewState.reviewTitle,
      reviewState.reviewMode,
      reviewState.defaultFileTreeVisible,
      reviewState.branchName,
      reviewState.targetBranchName,
      reviewState.focusFilePath,
      reviewState.sourceSubtaskId,
      refreshEnvironmentInfo,
      t,
      openReviewFromDiffLoader,
    ]
  )
  const refreshReview = useCallback(() => {
    if (!reviewState.reloadDiff) return

    void openReviewFromDiffLoader(reviewState.reloadDiff, {
      reviewTitle: reviewState.reviewTitle,
      reviewMode: reviewState.reviewMode,
      defaultFileTreeVisible: reviewState.defaultFileTreeVisible,
      branchName: reviewState.branchName,
      targetBranchName: reviewState.targetBranchName,
      focusFilePath: reviewState.focusFilePath,
      sourceSubtaskId: reviewState.sourceSubtaskId,
    })
  }, [
    openReviewFromDiffLoader,
    reviewState.branchName,
    reviewState.defaultFileTreeVisible,
    reviewState.focusFilePath,
    reviewState.reloadDiff,
    reviewState.reviewMode,
    reviewState.reviewTitle,
    reviewState.sourceSubtaskId,
    reviewState.targetBranchName,
  ])
  const reviewViewOptions = useMemo(
    () => [
      {
        id: 'unstaged',
        label: tChat('file_changes.unstaged_label'),
        active: reviewState.reviewMode === 'unstaged',
        disabled: !loadEnvironmentDiff || !workspaceTarget,
        onSelect: () => void openEnvironmentChangesReview('unstaged'),
      },
      {
        id: 'staged',
        label: tChat('file_changes.staged_label'),
        active: reviewState.reviewMode === 'staged',
        disabled: !loadEnvironmentDiff || !workspaceTarget,
        onSelect: () => void openEnvironmentChangesReview('staged'),
      },
      {
        id: 'commit',
        label: tChat('file_changes.commit_label'),
        active: reviewState.reviewMode === 'commit',
        disabled: !loadEnvironmentDiff || !workspaceTarget,
        onSelect: () => void openEnvironmentChangesReview('commit'),
      },
      {
        id: 'branch',
        label: tChat('file_changes.branch_label'),
        active: reviewState.reviewMode === 'branch',
        disabled: !loadEnvironmentDiff || !workspaceTarget,
        onSelect: () => void openEnvironmentChangesReview('branch'),
      },
      {
        id: 'previous-turn',
        label: tChat('file_changes.previous_turn_label'),
        active: reviewState.reviewMode === 'previous-turn',
        disabled: latestPreviousTurnSubtaskId === null && !hasPreviousTurnReview,
        onSelect: () => {
          const previousTurn =
            latestPreviousTurnSubtaskId !== null
              ? {
                  loadDiff: () =>
                    loadTurnFileChangesDiff(
                      latestPreviousTurnSubtaskId,
                      paneMessagesRef.current,
                      undefined,
                      currentRuntimeTask
                    ),
                  defaultFileTreeVisible: false,
                  sourceSubtaskId: latestPreviousTurnSubtaskId,
                }
              : previousTurnReviewRef.current
          if (!previousTurn) return
          void openReviewFromDiffLoader(previousTurn.loadDiff, {
            reviewTitle: tChat('file_changes.previous_turn_label'),
            reviewMode: 'previous-turn',
            defaultFileTreeVisible: previousTurn.defaultFileTreeVisible,
            sourceSubtaskId: previousTurn.sourceSubtaskId,
          })
        },
      },
    ],
    [
      currentRuntimeTask,
      hasPreviousTurnReview,
      latestPreviousTurnSubtaskId,
      loadEnvironmentDiff,
      loadTurnFileChangesDiff,
      openEnvironmentChangesReview,
      openReviewFromDiffLoader,
      paneMessagesRef,
      previousTurnReviewRef,
      reviewState.reviewMode,
      tChat,
      workspaceTarget,
    ]
  )
  const fileChangesDiffPreviewDisabledSubtaskId =
    rightPanelOpen &&
    rightPanelView === 'review' &&
    reviewState.reviewMode === 'previous-turn' &&
    reviewState.sourceSubtaskId &&
    (reviewState.loading || Boolean(reviewState.diff))
      ? reviewState.sourceSubtaskId
      : null
  return {
    openReviewFromDiffLoader,
    openDefaultEnvironmentChangesReview,
    selectReviewView,
    selectFilesView,
    selectFileWorkspaceTarget,
    openFileTab,
    handleFileWorkspaceSelectionChange,
    openAttachment,
    openWorkspaceFileFromMessage,
    openLocalSkillFile,
    applyReviewPatch,
    refreshReview,
    reviewViewOptions,
    fileChangesDiffPreviewDisabledSubtaskId,
  }
}
