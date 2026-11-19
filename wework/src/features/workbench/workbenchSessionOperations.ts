import type { useWorkbenchProjectActions } from './useWorkbenchProjectActions'
import type { WorkbenchPaneContextValue } from './workbenchContextTypes'
import type { RuntimeConversationStreamHandlers } from './runtimePaneMessages'
import type { settleRuntimeConversationGuidance } from './runtimeConversationCache'
import type { RuntimeTaskAddress, RuntimeContextUsage } from '@/types/api'
import type { useConsumeQueuedPluginTrial } from './useWorkbenchComposerCallbacks'
export interface WorkbenchSessionOperations {
  stableConsumeQueuedPluginTrial: ReturnType<typeof useConsumeQueuedPluginTrial>
  refreshDevicesAfterRestart: () => ReturnType<WorkbenchPaneContextValue['refreshDevices']>
  stableSelectProject: WorkbenchPaneContextValue['selectProject']
  stableSetProjectExecutionMode: WorkbenchPaneContextValue['setProjectExecutionMode']
  stableSetWorkbenchError: WorkbenchPaneContextValue['setWorkbenchError']
  stableSetProjectWorktreeBranch: WorkbenchPaneContextValue['setProjectWorktreeBranch']
  stableSelectProjectWorkspace: WorkbenchPaneContextValue['selectProjectWorkspace']
  stableSelectStandaloneDevice: WorkbenchPaneContextValue['selectStandaloneDevice']
  stableOpenStandaloneWorkspace: WorkbenchPaneContextValue['openStandaloneWorkspace']
  stableStartNewChat: WorkbenchPaneContextValue['startNewChat']
  stableStartNewSkillChat: WorkbenchPaneContextValue['startNewSkillChat']
  stableStartStandaloneChat: WorkbenchPaneContextValue['startStandaloneChat']
  stableStartNewProjectChat: WorkbenchPaneContextValue['startNewProjectChat']
  stableOpenRuntimeTask: WorkbenchPaneContextValue['openRuntimeTask']
  stableSearchRuntimeWork: WorkbenchPaneContextValue['searchRuntimeWork']
  stableSearchRuntimeTranscriptForPane: WorkbenchPaneContextValue['searchRuntimeTranscriptForPane']
  stableLoadRuntimeTranscriptForPane: WorkbenchPaneContextValue['loadRuntimeTranscriptForPane']
  stableSubscribeRuntimeTaskStream: WorkbenchPaneContextValue['subscribeRuntimeTaskStream']
  applyCanonicalRuntimeAction: RuntimeConversationStreamHandlers['onMessageAction']
  settleCanonicalRuntimeGuidance: typeof settleRuntimeConversationGuidance
  stableRefreshWorkLists: WorkbenchPaneContextValue['refreshWorkLists']
  syncRuntimeTaskSnapshot: (address: RuntimeTaskAddress) => void
  syncRuntimeTaskUntilExecutorSettles: (address: RuntimeTaskAddress) => Promise<void>
  syncRuntimeGoalSnapshot: (address: RuntimeTaskAddress) => void
  updateCanonicalRuntimeContextUsage: (
    address: RuntimeTaskAddress,
    usage: RuntimeContextUsage
  ) => void
  stableRenameRuntimeTask: WorkbenchPaneContextValue['renameRuntimeTask']
  stableArchiveRuntimeTask: WorkbenchPaneContextValue['archiveRuntimeTask']
  stableCancelRuntimeTask: WorkbenchPaneContextValue['cancelRuntimeTask']
  stableForceStartRuntimeTask: WorkbenchPaneContextValue['forceStartRuntimeTask']
  stableReorderQueuedRuntimeTask: WorkbenchPaneContextValue['reorderQueuedRuntimeTask']
  stableArchiveProjectConversations: WorkbenchPaneContextValue['archiveProjectConversations']
  stableArchiveProjectsConversations: WorkbenchPaneContextValue['archiveProjectsConversations']
  stableArchiveChatConversations: WorkbenchPaneContextValue['archiveChatConversations']
  stableForkCurrentRuntimeTask: WorkbenchPaneContextValue['forkCurrentRuntimeTask']
  stableGetRuntimeGoal: WorkbenchPaneContextValue['getRuntimeGoal']
  stableSetRuntimeGoal: WorkbenchPaneContextValue['setRuntimeGoal']
  stableClearRuntimeGoal: WorkbenchPaneContextValue['clearRuntimeGoal']
  stableListImPrivateSessions: WorkbenchPaneContextValue['listImPrivateSessions']
  stableGetImNotificationSettings: WorkbenchPaneContextValue['getImNotificationSettings']
  stableUpdateGlobalImNotification: WorkbenchPaneContextValue['updateGlobalImNotification']
  stableSubscribeRuntimeTaskNotifications: WorkbenchPaneContextValue['subscribeRuntimeTaskNotifications']
  stableUnsubscribeRuntimeTaskNotifications: WorkbenchPaneContextValue['unsubscribeRuntimeTaskNotifications']
  stableRefreshDevices: WorkbenchPaneContextValue['refreshDevices']
  stableUpgradeDevice: WorkbenchPaneContextValue['upgradeDevice']
  stableCreateProject: WorkbenchPaneContextValue['createProject']
  stableCreateLocalRuntimeProject: WorkbenchPaneContextValue['createLocalRuntimeProject']
  stableCreateGitWorkspaceProject: WorkbenchPaneContextValue['createGitWorkspaceProject']
  stablePrepareDeviceWorkspace: WorkbenchPaneContextValue['prepareDeviceWorkspace']
  stableDeleteDeviceWorkspace: WorkbenchPaneContextValue['deleteDeviceWorkspace']
  stableListGitRepositories: WorkbenchPaneContextValue['listGitRepositories']
  stableListGitBranches: WorkbenchPaneContextValue['listGitBranches']
  stableUpdateProjectName: WorkbenchPaneContextValue['updateProjectName']
  stableUpdateLocalRuntimeProject: WorkbenchPaneContextValue['updateLocalRuntimeProject']
  stableRemoveProject: WorkbenchPaneContextValue['removeProject']
  stableReorderRuntimeProjects: WorkbenchPaneContextValue['reorderRuntimeProjects']
  stableSetRuntimeProjectPinned: WorkbenchPaneContextValue['setRuntimeProjectPinned']
  stableSetRuntimeProjectAppearance: WorkbenchPaneContextValue['setRuntimeProjectAppearance']
  stableReorderRuntimeProjectTasks: WorkbenchPaneContextValue['reorderRuntimeProjectTasks']
  stableSetRuntimeTaskPinned: WorkbenchPaneContextValue['setRuntimeTaskPinned']
  stableGetDeviceHomeDirectory: WorkbenchPaneContextValue['getDeviceHomeDirectory']
  stableGetProjectWorkspaceRoot: WorkbenchPaneContextValue['getProjectWorkspaceRoot']
  stableListDeviceDirectories: WorkbenchPaneContextValue['listDeviceDirectories']
  stableCreateDeviceDirectory: WorkbenchPaneContextValue['createDeviceDirectory']
  stableCloneGitRepository: WorkbenchPaneContextValue['cloneGitRepository']
  stableLoadEnvironmentInfo: WorkbenchPaneContextValue['loadEnvironmentInfo']
  stableLoadEnvironmentDiff: WorkbenchPaneContextValue['loadEnvironmentDiff']
  stableCommitEnvironmentChanges: WorkbenchPaneContextValue['commitEnvironmentChanges']
  stableCommitAndPushEnvironmentChanges: WorkbenchPaneContextValue['commitAndPushEnvironmentChanges']
  stablePushEnvironmentChanges: WorkbenchPaneContextValue['pushEnvironmentChanges']
  stableListEnvironmentBranches: WorkbenchPaneContextValue['listEnvironmentBranches']
  stableCheckoutEnvironmentBranch: WorkbenchPaneContextValue['checkoutEnvironmentBranch']
  stableCreateEnvironmentBranch: WorkbenchPaneContextValue['createEnvironmentBranch']
  stableSendRuntimePaneMessage: WorkbenchPaneContextValue['sendRuntimePaneMessage']
  stableInterruptAndSendRuntimePaneMessage: WorkbenchPaneContextValue['interruptAndSendRuntimePaneMessage']
  stableSendRuntimePaneGuidance: WorkbenchPaneContextValue['sendRuntimePaneGuidance']
  stableCompactRuntimePaneTask: WorkbenchPaneContextValue['compactRuntimePaneTask']
  stableEditLastUserMessage: WorkbenchPaneContextValue['editLastUserMessage']
  stableCancelRuntimePaneTask: WorkbenchPaneContextValue['cancelRuntimePaneTask']
  stableSendCurrentInput: WorkbenchPaneContextValue['sendCurrentInput']
  stableCreateTemporaryRuntimeTask: WorkbenchPaneContextValue['createTemporaryRuntimeTask']
  stableCreateEphemeralRuntimeTask: WorkbenchPaneContextValue['createEphemeralRuntimeTask']
  stableCreateProjectRuntimeTask: WorkbenchPaneContextValue['createProjectRuntimeTask']
  stablePauseCurrentResponse: WorkbenchPaneContextValue['pauseCurrentResponse']
  stableLoadTurnFileChangesDiff: WorkbenchPaneContextValue['loadTurnFileChangesDiff']
  stableRevertTurnFileChanges: WorkbenchPaneContextValue['revertTurnFileChanges']
}
/** Public command identities belong to the real Workbench session, not a render's handler refs. */
export function createWorkbenchSessionOperations(
  read: () => WorkbenchSessionOperations
): WorkbenchSessionOperations {
  return {
    stableConsumeQueuedPluginTrial: (
      ...args: Parameters<WorkbenchSessionOperations['stableConsumeQueuedPluginTrial']>
    ) => read().stableConsumeQueuedPluginTrial(...args),
    refreshDevicesAfterRestart: (
      ...args: Parameters<WorkbenchSessionOperations['refreshDevicesAfterRestart']>
    ) => read().refreshDevicesAfterRestart(...args),
    stableSelectProject: (...args: Parameters<WorkbenchSessionOperations['stableSelectProject']>) =>
      read().stableSelectProject(...args),
    stableSetProjectExecutionMode: (
      ...args: Parameters<WorkbenchSessionOperations['stableSetProjectExecutionMode']>
    ) => read().stableSetProjectExecutionMode(...args),
    stableSetWorkbenchError: (
      ...args: Parameters<WorkbenchSessionOperations['stableSetWorkbenchError']>
    ) => read().stableSetWorkbenchError(...args),
    stableSetProjectWorktreeBranch: (
      ...args: Parameters<WorkbenchSessionOperations['stableSetProjectWorktreeBranch']>
    ) => read().stableSetProjectWorktreeBranch(...args),
    stableSelectProjectWorkspace: (
      ...args: Parameters<WorkbenchSessionOperations['stableSelectProjectWorkspace']>
    ) => read().stableSelectProjectWorkspace(...args),
    stableSelectStandaloneDevice: (
      ...args: Parameters<WorkbenchSessionOperations['stableSelectStandaloneDevice']>
    ) => read().stableSelectStandaloneDevice(...args),
    stableOpenStandaloneWorkspace: (
      ...args: Parameters<WorkbenchSessionOperations['stableOpenStandaloneWorkspace']>
    ) => read().stableOpenStandaloneWorkspace(...args),
    stableStartNewChat: (...args: Parameters<WorkbenchSessionOperations['stableStartNewChat']>) =>
      read().stableStartNewChat(...args),
    stableStartNewSkillChat: (
      ...args: Parameters<WorkbenchSessionOperations['stableStartNewSkillChat']>
    ) => read().stableStartNewSkillChat(...args),
    stableStartStandaloneChat: (
      ...args: Parameters<WorkbenchSessionOperations['stableStartStandaloneChat']>
    ) => read().stableStartStandaloneChat(...args),
    stableStartNewProjectChat: (
      ...args: Parameters<WorkbenchSessionOperations['stableStartNewProjectChat']>
    ) => read().stableStartNewProjectChat(...args),
    stableOpenRuntimeTask: (
      ...args: Parameters<WorkbenchSessionOperations['stableOpenRuntimeTask']>
    ) => read().stableOpenRuntimeTask(...args),
    stableSearchRuntimeWork: (
      ...args: Parameters<WorkbenchSessionOperations['stableSearchRuntimeWork']>
    ) => read().stableSearchRuntimeWork(...args),
    stableSearchRuntimeTranscriptForPane: (
      ...args: Parameters<WorkbenchSessionOperations['stableSearchRuntimeTranscriptForPane']>
    ) => read().stableSearchRuntimeTranscriptForPane(...args),
    stableLoadRuntimeTranscriptForPane: (
      ...args: Parameters<WorkbenchSessionOperations['stableLoadRuntimeTranscriptForPane']>
    ) => read().stableLoadRuntimeTranscriptForPane(...args),
    stableSubscribeRuntimeTaskStream: (
      ...args: Parameters<WorkbenchSessionOperations['stableSubscribeRuntimeTaskStream']>
    ) => read().stableSubscribeRuntimeTaskStream(...args),
    applyCanonicalRuntimeAction: (
      ...args: Parameters<WorkbenchSessionOperations['applyCanonicalRuntimeAction']>
    ) => read().applyCanonicalRuntimeAction(...args),
    settleCanonicalRuntimeGuidance: (
      ...args: Parameters<WorkbenchSessionOperations['settleCanonicalRuntimeGuidance']>
    ) => read().settleCanonicalRuntimeGuidance(...args),
    stableRefreshWorkLists: (
      ...args: Parameters<WorkbenchSessionOperations['stableRefreshWorkLists']>
    ) => read().stableRefreshWorkLists(...args),
    syncRuntimeTaskSnapshot: (
      ...args: Parameters<WorkbenchSessionOperations['syncRuntimeTaskSnapshot']>
    ) => read().syncRuntimeTaskSnapshot(...args),
    syncRuntimeTaskUntilExecutorSettles: (
      ...args: Parameters<WorkbenchSessionOperations['syncRuntimeTaskUntilExecutorSettles']>
    ) => read().syncRuntimeTaskUntilExecutorSettles(...args),
    syncRuntimeGoalSnapshot: (
      ...args: Parameters<WorkbenchSessionOperations['syncRuntimeGoalSnapshot']>
    ) => read().syncRuntimeGoalSnapshot(...args),
    updateCanonicalRuntimeContextUsage: (
      ...args: Parameters<WorkbenchSessionOperations['updateCanonicalRuntimeContextUsage']>
    ) => read().updateCanonicalRuntimeContextUsage(...args),
    stableRenameRuntimeTask: (
      ...args: Parameters<WorkbenchSessionOperations['stableRenameRuntimeTask']>
    ) => read().stableRenameRuntimeTask(...args),
    stableArchiveRuntimeTask: (
      ...args: Parameters<WorkbenchSessionOperations['stableArchiveRuntimeTask']>
    ) => read().stableArchiveRuntimeTask(...args),
    stableCancelRuntimeTask: (
      ...args: Parameters<WorkbenchSessionOperations['stableCancelRuntimeTask']>
    ) => read().stableCancelRuntimeTask(...args),
    stableForceStartRuntimeTask: (
      ...args: Parameters<WorkbenchSessionOperations['stableForceStartRuntimeTask']>
    ) => read().stableForceStartRuntimeTask(...args),
    stableReorderQueuedRuntimeTask: (
      ...args: Parameters<WorkbenchSessionOperations['stableReorderQueuedRuntimeTask']>
    ) => read().stableReorderQueuedRuntimeTask(...args),
    stableArchiveProjectConversations: (
      ...args: Parameters<WorkbenchSessionOperations['stableArchiveProjectConversations']>
    ) => read().stableArchiveProjectConversations(...args),
    stableArchiveProjectsConversations: (
      ...args: Parameters<WorkbenchSessionOperations['stableArchiveProjectsConversations']>
    ) => read().stableArchiveProjectsConversations(...args),
    stableArchiveChatConversations: (
      ...args: Parameters<WorkbenchSessionOperations['stableArchiveChatConversations']>
    ) => read().stableArchiveChatConversations(...args),
    stableForkCurrentRuntimeTask: (
      ...args: Parameters<WorkbenchSessionOperations['stableForkCurrentRuntimeTask']>
    ) => read().stableForkCurrentRuntimeTask(...args),
    stableGetRuntimeGoal: (
      ...args: Parameters<WorkbenchSessionOperations['stableGetRuntimeGoal']>
    ) => read().stableGetRuntimeGoal(...args),
    stableSetRuntimeGoal: (
      ...args: Parameters<WorkbenchSessionOperations['stableSetRuntimeGoal']>
    ) => read().stableSetRuntimeGoal(...args),
    stableClearRuntimeGoal: (
      ...args: Parameters<WorkbenchSessionOperations['stableClearRuntimeGoal']>
    ) => read().stableClearRuntimeGoal(...args),
    stableListImPrivateSessions: (
      ...args: Parameters<WorkbenchSessionOperations['stableListImPrivateSessions']>
    ) => read().stableListImPrivateSessions(...args),
    stableGetImNotificationSettings: (
      ...args: Parameters<WorkbenchSessionOperations['stableGetImNotificationSettings']>
    ) => read().stableGetImNotificationSettings(...args),
    stableUpdateGlobalImNotification: (
      ...args: Parameters<WorkbenchSessionOperations['stableUpdateGlobalImNotification']>
    ) => read().stableUpdateGlobalImNotification(...args),
    stableSubscribeRuntimeTaskNotifications: (
      ...args: Parameters<WorkbenchSessionOperations['stableSubscribeRuntimeTaskNotifications']>
    ) => read().stableSubscribeRuntimeTaskNotifications(...args),
    stableUnsubscribeRuntimeTaskNotifications: (
      ...args: Parameters<WorkbenchSessionOperations['stableUnsubscribeRuntimeTaskNotifications']>
    ) => read().stableUnsubscribeRuntimeTaskNotifications(...args),
    stableRefreshDevices: (
      ...args: Parameters<WorkbenchSessionOperations['stableRefreshDevices']>
    ) => read().stableRefreshDevices(...args),
    stableUpgradeDevice: (...args: Parameters<WorkbenchSessionOperations['stableUpgradeDevice']>) =>
      read().stableUpgradeDevice(...args),
    stableCreateProject: (...args: Parameters<WorkbenchSessionOperations['stableCreateProject']>) =>
      read().stableCreateProject(...args),
    stableCreateLocalRuntimeProject: (
      ...args: Parameters<WorkbenchSessionOperations['stableCreateLocalRuntimeProject']>
    ) => read().stableCreateLocalRuntimeProject(...args),
    stableCreateGitWorkspaceProject: (
      ...args: Parameters<WorkbenchSessionOperations['stableCreateGitWorkspaceProject']>
    ) => read().stableCreateGitWorkspaceProject(...args),
    stablePrepareDeviceWorkspace: (
      ...args: Parameters<WorkbenchSessionOperations['stablePrepareDeviceWorkspace']>
    ) => read().stablePrepareDeviceWorkspace(...args),
    stableDeleteDeviceWorkspace: (
      ...args: Parameters<WorkbenchSessionOperations['stableDeleteDeviceWorkspace']>
    ) => read().stableDeleteDeviceWorkspace(...args),
    stableListGitRepositories: (
      ...args: Parameters<WorkbenchSessionOperations['stableListGitRepositories']>
    ) => read().stableListGitRepositories(...args),
    stableListGitBranches: (
      ...args: Parameters<WorkbenchSessionOperations['stableListGitBranches']>
    ) => read().stableListGitBranches(...args),
    stableUpdateProjectName: (
      ...args: Parameters<WorkbenchSessionOperations['stableUpdateProjectName']>
    ) => read().stableUpdateProjectName(...args),
    stableUpdateLocalRuntimeProject: (
      ...args: Parameters<WorkbenchSessionOperations['stableUpdateLocalRuntimeProject']>
    ) => read().stableUpdateLocalRuntimeProject(...args),
    stableRemoveProject: (...args: Parameters<WorkbenchSessionOperations['stableRemoveProject']>) =>
      read().stableRemoveProject(...args),
    stableReorderRuntimeProjects: (
      ...args: Parameters<WorkbenchSessionOperations['stableReorderRuntimeProjects']>
    ) => read().stableReorderRuntimeProjects(...args),
    stableSetRuntimeProjectPinned: (
      ...args: Parameters<WorkbenchSessionOperations['stableSetRuntimeProjectPinned']>
    ) => read().stableSetRuntimeProjectPinned(...args),
    stableSetRuntimeProjectAppearance: (
      ...args: Parameters<WorkbenchSessionOperations['stableSetRuntimeProjectAppearance']>
    ) => read().stableSetRuntimeProjectAppearance(...args),
    stableReorderRuntimeProjectTasks: (
      ...args: Parameters<WorkbenchSessionOperations['stableReorderRuntimeProjectTasks']>
    ) => read().stableReorderRuntimeProjectTasks(...args),
    stableSetRuntimeTaskPinned: (
      ...args: Parameters<WorkbenchSessionOperations['stableSetRuntimeTaskPinned']>
    ) => read().stableSetRuntimeTaskPinned(...args),
    stableGetDeviceHomeDirectory: (
      ...args: Parameters<WorkbenchSessionOperations['stableGetDeviceHomeDirectory']>
    ) => read().stableGetDeviceHomeDirectory(...args),
    stableGetProjectWorkspaceRoot: (
      ...args: Parameters<WorkbenchSessionOperations['stableGetProjectWorkspaceRoot']>
    ) => read().stableGetProjectWorkspaceRoot(...args),
    stableListDeviceDirectories: (
      ...args: Parameters<WorkbenchSessionOperations['stableListDeviceDirectories']>
    ) => read().stableListDeviceDirectories(...args),
    stableCreateDeviceDirectory: (
      ...args: Parameters<WorkbenchSessionOperations['stableCreateDeviceDirectory']>
    ) => read().stableCreateDeviceDirectory(...args),
    stableCloneGitRepository: (
      ...args: Parameters<WorkbenchSessionOperations['stableCloneGitRepository']>
    ) => read().stableCloneGitRepository(...args),
    stableLoadEnvironmentInfo: (
      ...args: Parameters<WorkbenchSessionOperations['stableLoadEnvironmentInfo']>
    ) => read().stableLoadEnvironmentInfo(...args),
    stableLoadEnvironmentDiff: (
      ...args: Parameters<WorkbenchSessionOperations['stableLoadEnvironmentDiff']>
    ) => read().stableLoadEnvironmentDiff(...args),
    stableCommitEnvironmentChanges: (
      ...args: Parameters<WorkbenchSessionOperations['stableCommitEnvironmentChanges']>
    ) => read().stableCommitEnvironmentChanges(...args),
    stableCommitAndPushEnvironmentChanges: (
      ...args: Parameters<WorkbenchSessionOperations['stableCommitAndPushEnvironmentChanges']>
    ) => read().stableCommitAndPushEnvironmentChanges(...args),
    stablePushEnvironmentChanges: (
      ...args: Parameters<WorkbenchSessionOperations['stablePushEnvironmentChanges']>
    ) => read().stablePushEnvironmentChanges(...args),
    stableListEnvironmentBranches: (
      ...args: Parameters<WorkbenchSessionOperations['stableListEnvironmentBranches']>
    ) => read().stableListEnvironmentBranches(...args),
    stableCheckoutEnvironmentBranch: (
      ...args: Parameters<WorkbenchSessionOperations['stableCheckoutEnvironmentBranch']>
    ) => read().stableCheckoutEnvironmentBranch(...args),
    stableCreateEnvironmentBranch: (
      ...args: Parameters<WorkbenchSessionOperations['stableCreateEnvironmentBranch']>
    ) => read().stableCreateEnvironmentBranch(...args),
    stableSendRuntimePaneMessage: (
      ...args: Parameters<WorkbenchSessionOperations['stableSendRuntimePaneMessage']>
    ) => read().stableSendRuntimePaneMessage(...args),
    stableInterruptAndSendRuntimePaneMessage: (
      ...args: Parameters<WorkbenchSessionOperations['stableInterruptAndSendRuntimePaneMessage']>
    ) => read().stableInterruptAndSendRuntimePaneMessage(...args),
    stableSendRuntimePaneGuidance: (
      ...args: Parameters<WorkbenchSessionOperations['stableSendRuntimePaneGuidance']>
    ) => read().stableSendRuntimePaneGuidance(...args),
    stableCompactRuntimePaneTask: (
      ...args: Parameters<WorkbenchSessionOperations['stableCompactRuntimePaneTask']>
    ) => read().stableCompactRuntimePaneTask(...args),
    stableEditLastUserMessage: (
      ...args: Parameters<WorkbenchSessionOperations['stableEditLastUserMessage']>
    ) => read().stableEditLastUserMessage(...args),
    stableCancelRuntimePaneTask: (
      ...args: Parameters<WorkbenchSessionOperations['stableCancelRuntimePaneTask']>
    ) => read().stableCancelRuntimePaneTask(...args),
    stableSendCurrentInput: (
      ...args: Parameters<WorkbenchSessionOperations['stableSendCurrentInput']>
    ) => read().stableSendCurrentInput(...args),
    stableCreateTemporaryRuntimeTask: (
      ...args: Parameters<WorkbenchSessionOperations['stableCreateTemporaryRuntimeTask']>
    ) => read().stableCreateTemporaryRuntimeTask(...args),
    stableCreateEphemeralRuntimeTask: (
      ...args: Parameters<WorkbenchSessionOperations['stableCreateEphemeralRuntimeTask']>
    ) => read().stableCreateEphemeralRuntimeTask(...args),
    stableCreateProjectRuntimeTask: (
      ...args: Parameters<WorkbenchSessionOperations['stableCreateProjectRuntimeTask']>
    ) => read().stableCreateProjectRuntimeTask(...args),
    stablePauseCurrentResponse: (
      ...args: Parameters<WorkbenchSessionOperations['stablePauseCurrentResponse']>
    ) => read().stablePauseCurrentResponse(...args),
    stableLoadTurnFileChangesDiff: (
      ...args: Parameters<WorkbenchSessionOperations['stableLoadTurnFileChangesDiff']>
    ) => read().stableLoadTurnFileChangesDiff(...args),
    stableRevertTurnFileChanges: (
      ...args: Parameters<WorkbenchSessionOperations['stableRevertTurnFileChanges']>
    ) => read().stableRevertTurnFileChanges(...args),
  }
}

/** Project operations use the same command mapping in every Workbench owner. */
export function createWorkbenchProjectOperations(
  projectActions: ReturnType<typeof useWorkbenchProjectActions>
) {
  return {
    stableCreateProject: projectActions.createProject,
    stableCreateLocalRuntimeProject: projectActions.createLocalRuntimeProject,
    stableCreateGitWorkspaceProject: projectActions.createGitWorkspaceProject,
    stablePrepareDeviceWorkspace: projectActions.prepareDeviceWorkspace,
    stableDeleteDeviceWorkspace: projectActions.deleteDeviceWorkspace,
    stableListGitRepositories: projectActions.listGitRepositories,
    stableListGitBranches: projectActions.listGitBranches,
    stableUpdateProjectName: projectActions.updateProjectName,
    stableUpdateLocalRuntimeProject: projectActions.updateLocalRuntimeProject,
    stableRemoveProject: projectActions.removeProject,
    stableReorderRuntimeProjects: projectActions.reorderRuntimeProjects,
    stableSetRuntimeProjectPinned: projectActions.setRuntimeProjectPinned,
    stableSetRuntimeProjectAppearance: projectActions.setRuntimeProjectAppearance,
    stableReorderRuntimeProjectTasks: projectActions.reorderRuntimeProjectTasks,
    stableSetRuntimeTaskPinned: projectActions.setRuntimeTaskPinned,
    stableGetDeviceHomeDirectory: projectActions.getDeviceHomeDirectory,
    stableGetProjectWorkspaceRoot: projectActions.getProjectWorkspaceRoot,
    stableListDeviceDirectories: projectActions.listDeviceDirectories,
    stableCreateDeviceDirectory: projectActions.createDeviceDirectory,
    stableCloneGitRepository: projectActions.cloneGitRepository,
    stableLoadEnvironmentInfo: projectActions.loadEnvironmentInfo,
    stableLoadEnvironmentDiff: projectActions.loadEnvironmentDiff,
    stableCommitEnvironmentChanges: projectActions.commitEnvironmentChanges,
    stableCommitAndPushEnvironmentChanges: projectActions.commitAndPushEnvironmentChanges,
    stablePushEnvironmentChanges: projectActions.pushEnvironmentChanges,
    stableListEnvironmentBranches: projectActions.listEnvironmentBranches,
    stableCheckoutEnvironmentBranch: projectActions.checkoutEnvironmentBranch,
    stableCreateEnvironmentBranch: projectActions.createEnvironmentBranch,
  }
}
