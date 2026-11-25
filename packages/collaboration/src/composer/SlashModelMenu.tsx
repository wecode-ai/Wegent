import { Combobox, ComboboxInput, ComboboxList, ComboboxItem } from '@ui-sdk/react/combobox'
import { controlOption } from '../controls/recipes'
import type { ModelOptions, UnifiedModel } from '@wegent/chat-core/models'
import { Check, Search } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { getModelDisplayLabel, getModelUiMetadata, groupModelsByFamily } from '../controls/model-ui'
import type { CollaborationTranslate } from '../i18n'

export interface SlashModelMenuProps {
  translate: CollaborationTranslate
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  query: string
  selectedIndex: number
  className: string
  searchPlaceholder: string
  noResultsLabel: string
  onQueryChange: (query: string) => void
  onSelectedIndexChange: (index: number) => void
  onSelectModel: (model: UnifiedModel) => void
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
  onClose: () => void
  getCompatibilityDisabledMessage: (model: UnifiedModel) => string | undefined
}

function modelKey(model: UnifiedModel): string {
  return `${model.type}:${model.name}`
}

function modelUiText(model: UnifiedModel): Record<string, unknown> {
  const ui = model.config?.ui
  return ui && typeof ui === 'object' && !Array.isArray(ui) ? (ui as Record<string, unknown>) : {}
}

function modelDescription(
  model: UnifiedModel,
  resolveLabel?: (key: string, fallback: string) => string
): string {
  const ui = modelUiText(model)
  const descriptionKey = ui.descriptionKey
  const description = ui.description ?? ui.summary
  if (
    typeof descriptionKey === 'string' &&
    typeof description === 'string' &&
    description.trim() &&
    resolveLabel
  ) {
    return resolveLabel(descriptionKey, description)
  }
  if (typeof description === 'string' && description.trim()) return description.trim()
  return ''
}

function filterModels(
  models: UnifiedModel[],
  query: string,
  selectedModelOptions: ModelOptions,
  resolveLabel: (key: string, fallback: string) => string
): UnifiedModel[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return models

  return models.filter(model => {
    const searchableText = [
      model.name,
      model.displayName,
      model.modelId,
      getModelDisplayLabel(model, selectedModelOptions, resolveLabel),
      getModelUiMetadata(model).familyLabel,
      modelDescription(model, resolveLabel),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return searchableText.includes(normalizedQuery)
  })
}

export function SlashModelMenu({
  translate: t,
  models,
  selectedModel,
  selectedModelOptions,
  query,
  className,
  searchPlaceholder,
  noResultsLabel,
  onQueryChange,
  onSelectedIndexChange,
  onSelectModel,
  onBlockedModelSelect,
  onClose,
  getCompatibilityDisabledMessage,
}: SlashModelMenuProps) {
  const resolveLabel = useCallback((key: string, fallback: string) => t(key, fallback), [t])
  const orderedModels = useMemo(
    () => groupModelsByFamily(models).flatMap(group => group.models),
    [models]
  )
  const filteredModels = useMemo(
    () => filterModels(orderedModels, query, selectedModelOptions, resolveLabel),
    [orderedModels, query, resolveLabel, selectedModelOptions]
  )

  function handleSelect(model: UnifiedModel) {
    if (model.compatibilityDisabled) {
      onBlockedModelSelect?.(model, getCompatibilityDisabledMessage(model))
      return
    }
    onSelectModel(model)
  }

  return (
    <div data-testid="slash-model-menu" className={className}>
      <Combobox<string>
        open
        value={selectedModel ? modelKey(selectedModel) : null}
        query={query}
        filter={false}
        autoHighlight="always"
        onQueryChange={(next, details) => {
          if (details.reason === 'input-change' || details.reason === 'clear-press') {
            onQueryChange(next)
            onSelectedIndexChange(0)
          }
        }}
        onHighlight={next =>
          onSelectedIndexChange(filteredModels.findIndex(model => modelKey(model) === next))
        }
        onValueChange={next => {
          const model = filteredModels.find(model => modelKey(model) === next)
          if (model && !model.compatibilityDisabled) handleSelect(model)
        }}
        onOpenChange={next => {
          if (!next) onClose()
        }}
      >
        <label className="sticky top-0 z-10 flex h-9 max-md:min-h-11 items-center gap-2 rounded-xl bg-popover px-2 text-text-secondary">
          <Search className="h-4 w-4 shrink-0" />
          <ComboboxInput
            autoFocus
            data-testid="slash-model-search-input"
            aria-label={searchPlaceholder}
            placeholder={searchPlaceholder}
            className="min-w-0 max-md:min-h-11 flex-1 bg-transparent text-sm leading-[18px] text-text-primary outline-none placeholder:text-text-muted"
          />
        </label>

        {filteredModels.length > 0 ? (
          <ComboboxList
            aria-label={searchPlaceholder}
            data-testid="slash-model-list"
            className="py-1"
          >
            {filteredModels.map(model => {
              const selected =
                model.name === selectedModel?.name && model.type === selectedModel?.type
              const disabledMessage = getCompatibilityDisabledMessage(model)
              const disabled = Boolean(model.compatibilityDisabled)
              const description = disabledMessage || modelDescription(model, resolveLabel)

              return (
                <ComboboxItem
                  key={modelKey(model)}
                  render={<button type="button" />}
                  value={modelKey(model)}
                  label={getModelDisplayLabel(model, selectedModelOptions, resolveLabel)}
                  data-testid={`slash-model-option-${model.name}`}
                  aria-disabled={disabled}
                  title={disabledMessage}
                  onClick={() => {
                    if (disabled) handleSelect(model)
                  }}
                  className={[controlOption, disabled && 'cursor-not-allowed opacity-55'].join(' ')}
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-normal leading-5 text-text-primary">
                    {getModelDisplayLabel(model, selectedModelOptions, resolveLabel)}
                  </span>
                  {description && (
                    <span className="hidden min-w-0 flex-[1.35] truncate text-sm leading-5 text-text-muted sm:block">
                      {description}
                    </span>
                  )}
                  {selected && <Check className="h-4 w-4 shrink-0 text-text-secondary" />}
                </ComboboxItem>
              )
            })}
          </ComboboxList>
        ) : (
          <div className="px-2.5 py-3 text-sm leading-[18px] text-text-muted">{noResultsLabel}</div>
        )}
      </Combobox>
    </div>
  )
}
