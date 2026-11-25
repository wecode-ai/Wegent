import {
  RuntimeTaskRemindersContext,
  WorkbenchOwnerLeaseContext,
  WorkbenchQueueActionsContext,
  WorkbenchSidebarRemindersContext,
} from './workbenchContexts'
import { useRuntimeTaskReminders, type RuntimeTaskReminderState } from './runtimeTaskReminders'
import { AttachmentDownloadProvider } from '@/components/chat/AttachmentDownloadProvider'
import { WorkspaceFileReaderProvider } from '@/components/chat/WorkspaceFileReaderProvider'
import { DesktopGitAccountConfigurationProvider } from '@/components/settings/DesktopGitAccountConfigurationProvider'
import { QuestionDiscussionScope } from '@/features/notifications/QuestionDiscussionScope'
import { WorkbenchCloudDeviceRestarts } from '@/features/cloud-devices/WorkbenchCloudDeviceRestarts'
import {
  RuntimeTaskLifecycleProvider,
  useRuntimeTaskLifecycleStoreSnapshot,
  type RuntimeTaskLifecycleStore,
} from './runtimeTaskLifecycle'
import { WorkbenchContext, WorkbenchPaneContext } from './useWorkbench'
import type { WorkbenchContextValue, WorkbenchPaneContextValue } from './workbenchContextTypes'
import type { WorkbenchSessionOperations } from './workbenchSessionOperations'
import { useMemo, type ReactNode } from 'react'

function WorkbenchReminderProvider({
  runtimeWork,
  lifecycleStore,
  services,
  publish,
  children,
}: {
  runtimeWork: WorkbenchContextValue['state']['runtimeWork']
  lifecycleStore: RuntimeTaskLifecycleStore
  services: WorkbenchPaneContextValue['services']
  publish: (reminders: RuntimeTaskReminderState) => void
  children: ReactNode
}) {
  const lifecycleSnapshot = useRuntimeTaskLifecycleStoreSnapshot()
  const runtimeTaskReminders = useRuntimeTaskReminders({
    runtimeWork,
    lifecycleStore,
    lifecycleSnapshot,
    standInApi: services.standInApi,
    runtimeApi: services.runtimeWorkApi,
    publish,
  })
  const { unreadTaskKeys, unreadMessageCounts, markRuntimeTaskRead } = runtimeTaskReminders
  const sidebarReminders = useMemo(
    () => ({ unreadTaskKeys, unreadMessageCounts, markRuntimeTaskRead }),
    [unreadTaskKeys, unreadMessageCounts, markRuntimeTaskRead]
  )
  return (
    <RuntimeTaskRemindersContext.Provider value={runtimeTaskReminders}>
      <WorkbenchSidebarRemindersContext.Provider value={sidebarReminders}>
        {children}
      </WorkbenchSidebarRemindersContext.Provider>
    </RuntimeTaskRemindersContext.Provider>
  )
}

export function WorkbenchContextProviders({
  value,
  paneValue,
  sharedLifecycleStore,
  lifecycleStore,
  refreshDevicesAfterRestart,
  retainOwner,
  publishTaskReminders,
  children,
}: {
  value: WorkbenchContextValue
  paneValue: WorkbenchPaneContextValue
  sharedLifecycleStore: RuntimeTaskLifecycleStore
  lifecycleStore: RuntimeTaskLifecycleStore
  refreshDevicesAfterRestart: WorkbenchSessionOperations['refreshDevicesAfterRestart']
  retainOwner: () => () => void
  publishTaskReminders: (reminders: RuntimeTaskReminderState) => void
  children: ReactNode
}) {
  const { forceStartRuntimeTask, reorderQueuedRuntimeTask, setWorkbenchError } = value
  const queueActions = useMemo(
    () => ({ forceStartRuntimeTask, reorderQueuedRuntimeTask, setWorkbenchError }),
    [forceStartRuntimeTask, reorderQueuedRuntimeTask, setWorkbenchError]
  )
  return (
    <RuntimeTaskLifecycleProvider store={sharedLifecycleStore} writerStore={lifecycleStore}>
      <AttachmentDownloadProvider
        fetchAttachmentBlob={paneValue.services.attachmentApi?.fetchAttachmentBlob}
      >
        <WorkspaceFileReaderProvider
          readWorkspaceFileChunk={paneValue.workspaceFileApi.readWorkspaceFileChunk}
        >
          <WorkbenchContext.Provider value={value}>
            <WorkbenchPaneContext.Provider value={paneValue}>
              <WorkbenchOwnerLeaseContext.Provider value={retainOwner}>
                <DesktopGitAccountConfigurationProvider>
                  <WorkbenchCloudDeviceRestarts
                    devices={value.state.devices}
                    refreshDevices={refreshDevicesAfterRestart}
                  >
                    <WorkbenchQueueActionsContext.Provider value={queueActions}>
                      <WorkbenchReminderProvider
                        runtimeWork={value.state.runtimeWork}
                        lifecycleStore={lifecycleStore}
                        services={paneValue.services}
                        publish={publishTaskReminders}
                      >
                        <QuestionDiscussionScope>{children}</QuestionDiscussionScope>
                      </WorkbenchReminderProvider>
                    </WorkbenchQueueActionsContext.Provider>
                  </WorkbenchCloudDeviceRestarts>
                </DesktopGitAccountConfigurationProvider>
              </WorkbenchOwnerLeaseContext.Provider>
            </WorkbenchPaneContext.Provider>
          </WorkbenchContext.Provider>
        </WorkspaceFileReaderProvider>
      </AttachmentDownloadProvider>
    </RuntimeTaskLifecycleProvider>
  )
}
