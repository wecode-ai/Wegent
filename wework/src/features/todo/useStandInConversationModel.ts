import { useState } from 'react'
import { runnerModelKey, type WorkspaceStandInSettings } from '@wegent/collaboration'
import {
  getDefaultModelOptions,
  inferModelFamily,
  isSameModelSelection,
  normalizeModelOptionAliases,
  normalizeModelOptions,
} from '@wegent/collaboration/controls/model-ui'
import type { ConversationModelControls } from '@/components/layout/workspace-panels/conversationModelControls'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { ModelOptions, UnifiedModel } from '@/types/api'
import { useStandInModels } from './useStandInModels'

export function useStandInConversationModel(
  services: WorkbenchServices | undefined,
  settings: WorkspaceStandInSettings
): ConversationModelControls {
  // Stand-in conversations require the Codex approval path. Other profile uses
  // retain their saved runtime catalog through useStandInModels's default.
  const catalog = useStandInModels(services, settings, 'codex')
  const savedOptions = standInModelOptions(settings.modelOptions ?? {})
  const inheritedOptions = {
    ...(catalog.selectedModel ? getDefaultModelOptions(catalog.selectedModel) : {}),
    ...savedOptions,
  }
  // Late catalog defaults must not reset an explicit choice in this conversation.
  const key = JSON.stringify([
    settings.executionDeviceId,
    settings.model ? runnerModelKey(settings.model) : null,
    Object.entries(savedOptions).sort(([a], [b]) => a.localeCompare(b)),
  ])
  const [override, setOverride] = useState<{
    key: string
    model?: UnifiedModel | null
    options: ModelOptions
  } | null>(null)
  if (override && override.key !== key) setOverride(null)
  // A saved model change takes effect in this render, before another message can be sent.
  const selection = override?.key === key ? override : null
  const requestedModel = selection?.model === undefined ? catalog.selectedModel : selection.model
  const model = requestedModel
    ? (catalog.models.find(model => isSameModelSelection(model, requestedModel)) ?? requestedModel)
    : null
  const selectedIdentity = catalog.resolve(model)
  const unsupported = (selectedIdentity?.runtime ?? model?.runtime?.family) === 'claude_code'
  const options =
    selection?.model === undefined
      ? { ...inheritedOptions, ...selection?.options }
      : selection.options
  const select = (model: UnifiedModel | null, options: ModelOptions) =>
    setOverride({ key, model, options })
  return {
    models: catalog.models,
    selectedModel: model,
    selectedModelOptions: options,
    loading: catalog.loading,
    unavailable: unsupported || (!catalog.loading && !selectedIdentity),
    unavailableReason: unsupported ? 'conversation_runtime_unsupported' : undefined,
    onModelSelectorOpenChange: open => {
      if (open) catalog.refresh()
    },
    setSelectedModel: next =>
      select(
        next,
        next && model && inferModelFamily(next) === inferModelFamily(model)
          ? normalizeModelOptions(next, options)
          : next
            ? getDefaultModelOptions(next)
            : {}
      ),
    setSelectedModelAndOptions: select,
    setSelectedModelOption: (optionId, value) =>
      setOverride(current => ({
        key,
        // Option edits keep inheriting the model instead of capturing a loading placeholder.
        model: current?.key === key ? current.model : undefined,
        options: { ...(current?.key === key ? current.options : {}), [optionId]: value },
      })),
  }
}

function standInModelOptions(options: ModelOptions): ModelOptions {
  const canonical = { ...options }
  // Match the Executor's saved-option keys without changing ordinary chat selection.
  for (const [alias, key] of [
    ['reasoningEffort', 'reasoning'],
    ['serviceTier', 'speed'],
    ['service_tier', 'speed'],
    ['permission_mode', 'permissionMode'],
    ['collaboration_mode', 'collaborationMode'],
  ]) {
    if (canonical[alias] !== undefined) {
      if (canonical[key] === undefined) canonical[key] = canonical[alias]
      delete canonical[alias]
    }
  }
  return normalizeModelOptionAliases(canonical)
}
