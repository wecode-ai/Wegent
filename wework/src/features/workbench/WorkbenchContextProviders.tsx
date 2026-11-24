import { WorkbenchOwnerLeaseContext, WorkbenchQueueActionsContext } from './workbenchContexts'
import { AttachmentDownloadProvider } from '@/components/chat/AttachmentDownloadProvider'
import { WorkspaceFileReaderProvider } from '@/components/chat/WorkspaceFileReaderProvider'
import { DesktopGitAccountConfigurationProvider } from '@/components/settings/DesktopGitAccountConfigurationProvider'
import { QuestionDiscussionScope } from '@/features/notifications/QuestionDiscussionScope'
import { WorkbenchCloudDeviceRestarts } from '@/features/cloud-devices/WorkbenchCloudDeviceRestarts'
import {
  RuntimeTaskLifecycleProvider,
  type RuntimeTaskLifecycleStore,
} from './runtimeTaskLifecycle'
import { WorkbenchContext, WorkbenchPaneContext } from './useWorkbench'
import type { WorkbenchContextValue, WorkbenchPaneContextValue } from './workbenchContextTypes'
import type { WorkbenchSessionOperations } from './workbenchSessionOperations'
import { useMemo, type ReactNode } from 'react'
export function WorkbenchContextProviders({
  value,
  paneValue,
  sharedLifecycleStore,
  lifecycleStore,
  refreshDevicesAfterRestart,
  retainOwner,
  children,
}: {
  value: WorkbenchContextValue
  paneValue: WorkbenchPaneContextValue
  sharedLifecycleStore: RuntimeTaskLifecycleStore
  lifecycleStore: RuntimeTaskLifecycleStore
  refreshDevicesAfterRestart: WorkbenchSessionOperations['refreshDevicesAfterRestart']
  retainOwner: () => () => void
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
                      <QuestionDiscussionScope>{children}</QuestionDiscussionScope>
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
