import { useMemo, type Dispatch, type SetStateAction } from 'react'
import {
  createPluginTrialGuide,
  type PluginTrialGuide,
} from '@wegent/chat-core/composer-plugin-trial'
import type {
  WorkbenchContextValue,
  RuntimeTaskModelSelectionControls,
} from '@/features/workbench/workbenchContextTypes'
import type { useWorkbenchAttachments } from '@/features/workbench/useWorkbenchAttachments'
import type {
  ModelOptions,
  RuntimeContextUsage,
  RuntimeTaskAddress,
  UnifiedModel,
} from '@/types/api'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'

interface TemporaryChatControlsOptions {
  projectChat: WorkbenchContextValue['projectChat']
  instanceId: string
  trialGuide: PluginTrialGuide | null
  setTrialGuide: Dispatch<SetStateAction<PluginTrialGuide | null>>
  contextUsage: RuntimeContextUsage | null
  crossProviderSwitchBehavior?: 'new-session'
  address: RuntimeTaskAddress | null
  taskModelSelection: RuntimeTaskModelSelectionControls | null
  attachmentSelection: ReturnType<typeof useWorkbenchAttachments>
}

export function useTemporaryChatControls({
  projectChat,
  instanceId,
  trialGuide,
  setTrialGuide,
  contextUsage,
  crossProviderSwitchBehavior,
  address,
  taskModelSelection,
  attachmentSelection,
}: TemporaryChatControlsOptions) {
  const controls = useMemo(
    () => ({
      ...projectChat,
      scopeKey: instanceId,
      trialTemplates: trialGuide?.templates ?? [],
      trialPluginName: trialGuide?.pluginName,
      trialPluginApp: trialGuide?.app,
      showTrialGuide: (title: string, app: import('@/types/api').LocalDeviceApp) =>
        setTrialGuide(createPluginTrialGuide(title, app.trialTemplates, app)),
      dismissTrialGuide: () => setTrialGuide(null),
      onDismissTrialGuide: undefined,
      onRefineTrialPrompt: undefined,
      contextUsage: contextUsage ?? undefined,
      crossProviderSwitchBehavior,
      ...(address && taskModelSelection
        ? {
            activeModel: taskModelSelection.activeModel,
            selectedModel: taskModelSelection.selectedModel,
            selectedModelOptions: taskModelSelection.selectedModelOptions,
            setSelectedModel: (model: UnifiedModel | null) =>
              projectChat.setRuntimeTaskSelectedModel(address, model),
            setSelectedModelAndOptions: (model: UnifiedModel, options: ModelOptions) =>
              projectChat.setRuntimeTaskSelectedModelAndOptions(address, model, options),
            continueInNewConversation: (
              model: UnifiedModel,
              options?: ModelOptions,
              source?: { draft?: string }
            ) =>
              projectChat.continueInNewConversation?.(model, options, {
                ...source,
                address,
              }),
            setSelectedModelOption: (optionId: string, value: string) =>
              projectChat.setRuntimeTaskSelectedModelOption(address, optionId, value),
            getSelectedModel: () =>
              projectChat.resolveRuntimeTaskModelSelection(address).selectedModel,
            getSelectedModelOptions: () =>
              projectChat.resolveRuntimeTaskModelSelection(address).selectedModelOptions,
          }
        : {}),
      hasConversationContext: Boolean(address),
      attachments: attachmentSelection.attachments,
      uploadingFiles: attachmentSelection.uploadingFiles,
      errors: attachmentSelection.errors,
      isAttachmentReadyToSend: attachmentSelection.isAttachmentReadyToSend,
      handleFileSelect: attachmentSelection.handleFileSelect,
      addExistingAttachment: attachmentSelection.addExistingAttachment,
      removeAttachment: attachmentSelection.removeAttachment,
      resetAttachments: attachmentSelection.resetAttachments,
    }),
    [
      address,
      attachmentSelection,
      contextUsage,
      crossProviderSwitchBehavior,
      projectChat,
      taskModelSelection,
      instanceId,
      trialGuide,
      setTrialGuide,
    ]
  )
  const selectedModelFields = useMemo(() => {
    if (address && taskModelSelection) {
      if (taskModelSelection.selectedModel) {
        return selectedModelExecutionFields(
          taskModelSelection.selectedModel,
          taskModelSelection.selectedModelOptions
        )
      }
      if (taskModelSelection.taskSelection?.modelName) {
        return {
          modelId: taskModelSelection.taskSelection.modelName,
          modelType: taskModelSelection.taskSelection.modelType,
          modelOptions: taskModelSelection.selectedModelOptions,
        }
      }
    }
    return selectedModelExecutionFields(
      projectChat.getSelectedModel?.() ?? projectChat.selectedModel,
      projectChat.getSelectedModelOptions?.() ?? projectChat.selectedModelOptions
    )
  }, [address, taskModelSelection, projectChat])
  return { controls, selectedModelFields }
}
