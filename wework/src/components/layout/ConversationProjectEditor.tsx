import { useMemo } from 'react'
import { LocalProjectEditDialog } from '@/components/projects/LocalProjectEditDialog'
import { projectSpaceApis } from '@/features/todo/projectSpaceSelection'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import { getRuntimeProjectOwner } from '@/lib/runtime-project-state'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import type { RuntimeProjectWork } from '@/types/api'

export function ConversationProjectEditor({
  projectWork,
  onClose,
}: {
  projectWork: RuntimeProjectWork
  onClose: () => void
}) {
  const workbench = useWorkbench()
  const { project } = projectWork
  const apis = useMemo(() => projectSpaceApis(workbench.services), [workbench.services])
  const owner = getRuntimeProjectOwner(projectWork)
  const pluginApi = useMemo(
    () => workbench.services.projectDevicePluginApi?.(owner.deviceId),
    [workbench.services, owner.deviceId]
  )
  const projectId = runtimeProjectUiId(project)

  return (
    <LocalProjectEditDialog
      open
      projectWork={projectWork}
      device={findWorkbenchDevice(workbench.state.devices, owner.deviceId)}
      onGetDeviceHomeDirectory={workbench.getDeviceHomeDirectory}
      onListDeviceDirectories={workbench.listDeviceDirectories}
      onCreateDeviceDirectory={workbench.createDeviceDirectory}
      projectSpaceApis={apis}
      models={workbench.projectChat.models}
      pluginApi={pluginApi}
      onClose={onClose}
      onSave={workbench.updateLocalRuntimeProject}
      onDelete={() => {
        onClose()
        void workbench.removeProject(projectId)
      }}
    />
  )
}
