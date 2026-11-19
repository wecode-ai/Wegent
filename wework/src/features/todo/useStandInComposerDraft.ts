import { useState } from 'react'
import type { RunnerModelIdentity, WorkspaceStandInSettings } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useStandInModels } from './useStandInModels'

/** The displayed implicit model belongs to the editable draft until an explicit choice replaces it. */
export function useStandInComposerDraft(
  settings: WorkspaceStandInSettings,
  services?: WorkbenchServices,
  showPrompt = true
) {
  const [implicit, setImplicit] = useState<{
    services: WorkbenchServices | undefined
    deviceId: string
    roleId: string | undefined
    version: number
    model: RunnerModelIdentity | null
  }>(() => ({
    services,
    deviceId: settings.executionDeviceId,
    roleId: settings.id,
    version: settings.version,
    model: null,
  }))
  const sameOwner =
    implicit.services === services &&
    implicit.deviceId === settings.executionDeviceId &&
    implicit.roleId === settings.id &&
    implicit.version === settings.version
  const retained = !settings.model && sameOwner ? implicit.model : null
  const models = useStandInModels(services, retained ? { ...settings, model: retained } : settings)
  const model = retained ?? (showPrompt && !settings.model ? models.defaultIdentity : null)
  const next = {
    services,
    deviceId: settings.executionDeviceId,
    roleId: settings.id,
    version: settings.version,
    model,
  }
  if (!sameOwner || implicit.model !== model) setImplicit(next)
  return {
    draft: model && !settings.model ? { ...settings, model } : settings,
    models,
  }
}
