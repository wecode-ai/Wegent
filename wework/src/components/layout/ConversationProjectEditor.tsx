import { useMemo } from 'react'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { TextInputDialog } from '@/components/common/TextInputDialog'
import { LocalProjectEditDialog } from '@/components/projects/LocalProjectEditDialog'
import { projectSpaceApis } from '@/features/todo/projectSpaceSelection'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import { getLocalRuntimeStateDeviceId } from '@/lib/runtime-project-state'
import type { RuntimeProjectWork } from '@/types/api'

export function ConversationProjectEditor({
  projectWork,
  onClose,
}: {
  projectWork: RuntimeProjectWork
  onClose: () => void
}) {
  const { t } = useTranslation('common')
  const workbench = useWorkbench()
  const { project } = projectWork
  const apis = useMemo(() => projectSpaceApis(workbench.services), [workbench.services])
  const pluginApi = useMemo(() => createLocalCodexPluginApi(), [])
  const projectId = runtimeProjectUiId(project)
  const canEditLocal =
    project.stateDeviceId === getLocalRuntimeStateDeviceId(workbench.state.devices) &&
    project.source !== 'remote_project'

  if (!canEditLocal) {
    return (
      <TextInputDialog
        open
        title={t('workbench.rename_project')}
        label={t('workbench.project_name')}
        initialValue={project.name}
        confirmLabel={t('workbench.save')}
        cancelLabel={t('workbench.cancel')}
        inputTestId="rename-project-input"
        confirmTestId="confirm-rename-project-button"
        onClose={onClose}
        onSubmit={name => workbench.updateProjectName(projectId, name)}
      />
    )
  }

  return (
    <LocalProjectEditDialog
      open
      projectWork={projectWork}
      device={
        workbench.state.devices.find(device => device.device_id === project.stateDeviceId) ?? null
      }
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
