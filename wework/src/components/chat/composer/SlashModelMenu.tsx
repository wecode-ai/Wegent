import { Check, Search } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { useCallback, useMemo } from 'react'
import { isImeEnterEvent } from '@/lib/ime'
import { getModelDisplayLabel, getModelUiMetadata, groupModelsByFamily } from '@/lib/model-ui'
import { useTranslation } from '@/hooks/useTranslation'
import type { ModelOptions, UnifiedModel } from '@/types/api'

interface SlashModelMenuProps {
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
  models,
  selectedModel,
  selectedModelOptions,
  query,
  selectedIndex,
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
  const { t } = useTranslation('common')
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

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      onSelectedIndexChange(Math.min(selectedIndex + 1, Math.max(filteredModels.length - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      onSelectedIndexChange(Math.max(selectedIndex - 1, 0))
      return
    }
    if (isImeEnterEvent(event)) return
    if (event.key === 'Enter' && filteredModels[selectedIndex]) {
      event.preventDefault()
      handleSelect(filteredModels[selectedIndex])
    }
  }

  return (
    <div
      data-testid="slash-model-menu"
      role="dialog"
      aria-label={searchPlaceholder}
      className={[
        'absolute bottom-[calc(100%+0.5rem)] z-popover max-h-80 overflow-hidden rounded-2xl border border-border bg-background p-1.5 text-text-primary shadow-[0_12px_34px_rgba(0,0,0,0.12)]',
        className,
      ].join(' ')}
      onKeyDown={handleKeyDown}
    >
      <label className="flex h-9 items-center gap-2 rounded-xl px-2 text-text-secondary">
        <Search className="h-4 w-4 shrink-0" />
        <input
          autoFocus
          data-testid="slash-model-search-input"
          value={query}
          onChange={event => {
            onQueryChange(event.target.value)
            onSelectedIndexChange(0)
          }}
          placeholder={searchPlaceholder}
          className="min-w-0 flex-1 bg-transparent text-sm leading-[18px] text-text-primary outline-none placeholder:text-text-muted"
        />
      </label>

      {filteredModels.length > 0 ? (
        <div
          data-testid="slash-model-list"
          role="listbox"
          className="max-h-64 overflow-y-auto py-1"
        >
          {filteredModels.map((model, index) => {
            const selected =
              model.name === selectedModel?.name && model.type === selectedModel?.type
            const highlighted = index === selectedIndex
            const disabledMessage = getCompatibilityDisabledMessage(model)
            const disabled = Boolean(model.compatibilityDisabled)
            const description = disabledMessage || modelDescription(model, resolveLabel)

            return (
              <button
                key={modelKey(model)}
                type="button"
                data-testid={`slash-model-option-${model.name}`}
                role="option"
                aria-selected={highlighted}
                aria-disabled={disabled}
                title={disabledMessage}
                onMouseEnter={() => onSelectedIndexChange(index)}
                onPointerEnter={() => onSelectedIndexChange(index)}
                onClick={() => handleSelect(model)}
                className={[
                  'flex h-10 w-full min-w-0 items-center gap-3 rounded-xl px-2.5 text-left',
                  disabled && 'cursor-not-allowed opacity-55',
                  highlighted ? 'bg-muted' : 'hover:bg-muted',
                ].join(' ')}
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5 text-text-primary">
                  {getModelDisplayLabel(model, selectedModelOptions, resolveLabel)}
                </span>
                {description && (
                  <span className="hidden min-w-0 flex-[1.35] truncate text-sm leading-5 text-text-muted sm:block">
                    {description}
                  </span>
                )}
                {selected && <Check className="h-4 w-4 shrink-0 text-text-secondary" />}
              </button>
            )
          })}
        </div>
      ) : (
        <div className="px-2.5 py-3 text-sm leading-[18px] text-text-muted">{noResultsLabel}</div>
      )}
    </div>
  )
}
