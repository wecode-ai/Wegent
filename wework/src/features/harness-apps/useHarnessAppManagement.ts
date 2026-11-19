import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useTranslation } from '@/hooks/useTranslation'
import { listLocalHarnessModelOptions } from '@/features/local-harness/localHarnessModels'
import {
  createHarnessAppManagementSource,
  type HarnessAppManagementOptions,
} from './harnessAppManagementSource'

export function useHarnessAppManagement(options: HarnessAppManagementOptions) {
  const { t } = useTranslation('common')
  const { projectChat, services } = useWorkbench()
  const workspaceTabs = useWorkspaceTabs()
  const modelOptions = useMemo(
    () => listLocalHarnessModelOptions('opencode', projectChat.models),
    [projectChat.models]
  )
  const [source] = useState(() =>
    createHarnessAppManagementSource({ ...options, modelOptions, workspaceTabs, services, t })
  )
  const subscribe = useCallback(
    (notify: () => void) =>
      source.subscribe(notify, { ...options, modelOptions, workspaceTabs, services, t }),
    [source, options, modelOptions, workspaceTabs, services, t]
  )
  const snapshot = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  return {
    changeModel: source.changeModel,
    hasSelectedModel: source.hasSelectedModel,
    modelOptions: snapshot.modelOptions,
    open: source.open,
    start: source.start,
    stop: source.stop,
    busyInstallationId: snapshot.busyInstallationId,
    error: snapshot.error,
  }
}
