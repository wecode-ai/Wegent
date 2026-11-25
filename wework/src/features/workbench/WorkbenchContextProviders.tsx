import {
  RuntimeTaskRemindersContext,
  WorkbenchOwnerLeaseContext,
  WorkbenchQueueActionsContext,
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
  type RuntimeTaskLifecycleStoreSnapshot,
} from './runtimeTaskLifecycle'
import { WorkbenchContext, WorkbenchPaneContext } from './useWorkbench'
import type { WorkbenchContextValue, WorkbenchPaneContextValue } from './workbenchContextTypes'
import type { WorkbenchSessionOperations } from './workbenchSessionOperations'
import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react'

type PublishTaskReminders = (
  reminders: RuntimeTaskReminderState,
  lifecycle: RuntimeTaskLifecycleStoreSnapshot
) => void

function TaskRemindersProvider({
  runtimeWork,
  services,
  lifecycleStore,
  publish,
  children,
}: {
  runtimeWork: WorkbenchContextValue['state']['runtimeWork']
  services: WorkbenchPaneContextValue['services']
  lifecycleStore: RuntimeTaskLifecycleStore
  publish: PublishTaskReminders
  children: ReactNode
}) {
  const lifecycleSnapshot = useRuntimeTaskLifecycleStoreSnapshot()
  const reminders = useRuntimeTaskReminders({
    runtimeWork,
    lifecycleStore,
    lifecycleSnapshot,
    standInApi: services.standInApi,
    runtimeApi: services.runtimeWorkApi,
  })
  const subscribe = useCallback(() => {
    publish(reminders, lifecycleSnapshot)
    return () => {}
  }, [publish, reminders, lifecycleSnapshot])
  useSyncExternalStore(subscribe, () => null)
  return (
    <RuntimeTaskRemindersContext.Provider value={reminders}>
      {children}
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
  publishTaskReminders: PublishTaskReminders
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
                      <TaskRemindersProvider
                        runtimeWork={value.state.runtimeWork}
                        services={paneValue.services}
                        lifecycleStore={lifecycleStore}
                        publish={publishTaskReminders}
                      >
                        <QuestionDiscussionScope>{children}</QuestionDiscussionScope>
                      </TaskRemindersProvider>
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
