import { useState } from 'react'
import type {
  CollaborationExecutionEnvironment,
  CollaborationTranslate,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import {
  ProjectEnvironmentDevices,
  useExecutionEnvironmentList,
} from '@wegent/collaboration/project-manage'

export function GroupExecutionDevices({
  api,
  groupId,
  store,
  currentUserId,
  canManage,
  translate,
}: {
  api: SharedWorkspaceApi
  groupId: string
  store: 'local' | 'cloud'
  currentUserId: number
  canManage: boolean
  translate: CollaborationTranslate
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mutationError, setMutationError] = useState('')
  const [status, setStatus] = useState<'all' | CollaborationExecutionEnvironment['status']>('all')
  const assigned = useExecutionEnvironmentList(api, 'project', groupId)
  const available = useExecutionEnvironmentList(
    api,
    store === 'local' ? 'device-local' : 'device-cloud',
    '',
    pickerOpen && canManage
  )
  const items = assigned.items ?? []
  const candidates = (available.items ?? []).filter(
    device =>
      device.device_id != null &&
      !items.some(item => item.device_id === device.device_id) &&
      (store === 'local' ||
        (device.owner_type === 'user' && device.owner_id === String(currentUserId)))
  )
  const mutate = async (device: CollaborationExecutionEnvironment, add: boolean) => {
    if (!canManage || saving || device.device_id == null) return
    setSaving(true)
    setMutationError('')
    try {
      if (add) {
        const granted = await api.projects.addExecutionEnvironment(groupId, device.device_id)
        assigned.update(previous => [
          ...previous.filter(item => item.device_id !== granted.device_id),
          granted,
        ])
      } else {
        await api.projects.removeExecutionEnvironment(groupId, device.device_id)
        assigned.update(previous => previous.filter(item => item.device_id !== device.device_id))
      }
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  return (
    <ProjectEnvironmentDevices
      testIdPrefix="group-execution-device"
      translate={translate}
      isWorkspaceScope={false}
      requireWorkspaceSharing={false}
      canManage={canManage}
      saving={saving}
      loading={assigned.loading}
      error={mutationError || (assigned.error ? String(assigned.error) : '')}
      pickerLoading={available.loading}
      pickerError={available.error ? String(available.error) : ''}
      onRetry={() => {
        setMutationError('')
        void assigned.refresh()
      }}
      onRetryPicker={() => void available.refresh()}
      assignedItems={items}
      visibleAssignedItems={items.filter(item => status === 'all' || item.status === status)}
      candidates={candidates}
      workspaceDeviceIds={undefined}
      deviceStates={{}}
      initializingDeviceId={null}
      configurationDirty={false}
      showPreparationActions={false}
      statusFilter={status}
      onStatusFilterChange={setStatus}
      pickerOpen={pickerOpen}
      onTogglePicker={() => setPickerOpen(value => !value)}
      addEnvironment={device => mutate(device, true)}
      removeEnvironment={device => mutate(device, false)}
      createEnvironmentOnDevice={async () => {
        throw new Error('Group devices do not prepare project directories')
      }}
    />
  )
}
