import { useLocalManagementAdvancedSettings } from '@wecode/hooks/useLocalManagementAdvancedSettings'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { LocalManagementPage } from './LocalManagementPage'
import { useLocalExecutorManagement } from './useLocalExecutorManagement'

export function LocalManagementSection() {
  const { state } = useWorkbench()
  const localExecutor = useLocalExecutorManagement()
  const { advancedSettingsEnabled, showAdvancedSettingsToast, handleTitleClick } =
    useLocalManagementAdvancedSettings()

  return (
    <>
      <LocalManagementPage
        state={localExecutor.state}
        devices={state.devices}
        onRefresh={localExecutor.refreshLocalExecutor}
        onRunAction={localExecutor.runExecutorAction}
        onOpenLogs={localExecutor.openExecutorLogs}
        onCleanProcesses={localExecutor.cleanExecutorProcesses}
        onChangeEnv={localExecutor.changeExecutorEnv}
        onAddEnv={localExecutor.addExecutorEnv}
        onDeleteEnv={localExecutor.deleteExecutorEnv}
        onToggleEnvExpanded={localExecutor.toggleExecutorEnvExpanded}
        advancedSettingsEnabled={advancedSettingsEnabled}
        onTitleClick={handleTitleClick}
      />
      {showAdvancedSettingsToast ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="advanced-settings-toast"
          className="fixed bottom-5 right-5 z-50 rounded-xl border border-border bg-background px-4 py-3 text-sm font-semibold text-text-primary shadow-lg"
        >
          已开启高级设置
        </div>
      ) : null}
    </>
  )
}
