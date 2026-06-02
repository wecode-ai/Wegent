import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  type ModelControlConfig,
  getControlsForModel,
  getModelDisplayLabel,
  getSelectedModelDisplayLabel,
  groupModelsByFamily,
  inferModelFamily,
} from '@/lib/model-ui'
import type { ModelOptions, UnifiedModel } from '@/types/api'
import { useOutsideClick } from './useOutsideClick'

const MAIN_MENU_WIDTH = 256
const SUBMENU_WIDTH = 288
const SUBMENU_GAP = 8
const VIEWPORT_MARGIN = 16
const SUBMENU_RIGHT_OFFSET = MAIN_MENU_WIDTH + SUBMENU_GAP
const SUBMENU_LEFT_OFFSET = -(SUBMENU_WIDTH + SUBMENU_GAP)

interface ModelSelectorProps {
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  disabled: boolean
  onSelectModel: (model: UnifiedModel | null) => void
  onSelectModelOption: (optionId: string, value: string) => void
  menuPlacement?: 'above' | 'below'
  buttonClassName?: string
  menuClassName?: string
}

export function ModelSelector({
  models,
  selectedModel,
  selectedModelOptions,
  disabled,
  onSelectModel,
  onSelectModelOption,
  menuPlacement = 'above',
  buttonClassName = '',
  menuClassName = '',
}: ModelSelectorProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const menuPanelRef = useRef<HTMLDivElement>(null)
  const familyButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const [open, setOpen] = useState(false)
  const [submenuOffset, setSubmenuOffset] = useState(0)
  const [submenuLeft, setSubmenuLeft] = useState(SUBMENU_RIGHT_OFFSET)
  const familyGroups = useMemo(() => groupModelsByFamily(models), [models])
  const selectedFamily = selectedModel ? inferModelFamily(selectedModel) : familyGroups[0]?.config.id
  const [activeFamilyId, setActiveFamilyId] = useState(selectedFamily ?? '')
  const displayedFamilyId =
    activeFamilyId || selectedFamily || familyGroups[0]?.config.id || ''
  const activeGroup =
    familyGroups.find(group => group.config.id === displayedFamilyId) ?? familyGroups[0]
  const closeMenu = useCallback(() => setOpen(false), [])
  const handleSelectModelOption = useCallback(
    (optionId: string, value: string) => {
      onSelectModelOption(optionId, value)
      setOpen(false)
    },
    [onSelectModelOption],
  )
  const updateSubmenuLayout = useCallback((target: HTMLElement | null) => {
    if (!target || !menuPanelRef.current) {
      setSubmenuOffset(0)
      setSubmenuLeft(SUBMENU_RIGHT_OFFSET)
      return
    }

    const menuRect = menuPanelRef.current.getBoundingClientRect()
    const menuTop = menuRect.top
    const targetTop = target.getBoundingClientRect().top
    setSubmenuOffset(Math.max(0, Math.round(targetTop - menuTop)))

    const rightSideLeft = SUBMENU_RIGHT_OFFSET
    const rightSideEdge = menuRect.left + rightSideLeft + SUBMENU_WIDTH
    const viewportWidth = window.innerWidth
    if (rightSideEdge <= viewportWidth - VIEWPORT_MARGIN) {
      setSubmenuLeft(rightSideLeft)
      return
    }

    const leftSideLeft = SUBMENU_LEFT_OFFSET
    if (menuRect.left + leftSideLeft >= VIEWPORT_MARGIN) {
      setSubmenuLeft(leftSideLeft)
      return
    }

    const viewportFittedLeft = Math.max(
      VIEWPORT_MARGIN - menuRect.left,
      Math.min(
        rightSideLeft,
        viewportWidth - VIEWPORT_MARGIN - SUBMENU_WIDTH - menuRect.left,
      ),
    )
    setSubmenuLeft(Math.round(viewportFittedLeft))
  }, [])
  const activateFamily = useCallback(
    (familyId: string, target?: HTMLElement | null) => {
      setActiveFamilyId(current => (current === familyId ? current : familyId))
      updateSubmenuLayout(target ?? familyButtonRefs.current.get(familyId) ?? null)
    },
    [updateSubmenuLayout],
  )

  useOutsideClick(containerRef, open, closeMenu)

  useLayoutEffect(() => {
    if (!open) return
    updateSubmenuLayout(familyButtonRefs.current.get(displayedFamilyId) ?? null)
  }, [displayedFamilyId, open, updateSubmenuLayout])

  const menuPositionClass =
    menuPlacement === 'below'
      ? 'top-[52px] left-0'
      : 'bottom-[52px] left-0'
  const buttonLabel =
    getSelectedModelDisplayLabel(
      selectedModel,
      selectedModelOptions,
      (key, fallback) => t(key, fallback),
    ) ||
    t('workbench.default_model')
  const controlsAboveFamilies = useMemo(() => {
    const controls = selectedModel
      ? getControlsForModel(selectedModel)
      : activeGroup?.config.controls ?? []
    return controls.filter(control => (control.scope ?? 'family') === 'family')
  }, [activeGroup, selectedModel])
  const supportsReasoningControl = controlsAboveFamilies.some(
    control => control.id === 'reasoning',
  )
  const selectedModelControls = selectedModel
    ? getControlsForModel(selectedModel).filter(control => control.scope === 'model')
    : []
  const controlsBelowModels =
    selectedModelControls.filter(control => control.placement === 'belowModels')

  function renderControlSection(control: ModelControlConfig) {
    return (
      <div key={control.id}>
        <div className="px-3 pb-1 pt-0.5 text-sm font-semibold text-text-muted">
          {control.labelKey ? t(control.labelKey) : control.label}
        </div>
        <div className="space-y-0.5">
          {control.options
            .slice()
            .sort((a, b) => a.order - b.order)
            .map(option => {
              const selected =
                (selectedModelOptions[control.id] ?? control.defaultValue) ===
                option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  data-testid={`model-control-${control.id}-${option.value}`}
                  onClick={() => handleSelectModelOption(control.id, option.value)}
                  className="flex min-h-8 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-sm text-text-primary hover:bg-muted"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      {option.labelKey ? t(option.labelKey) : option.label}
                    </span>
                    {option.description && (
                      <span className="mt-0.5 block text-xs text-text-muted">
                        {option.description}
                      </span>
                    )}
                  </span>
                  {selected && (
                    <Check className="h-4 w-4 shrink-0 text-text-secondary" />
                  )}
                </button>
              )
            })}
        </div>
      </div>
    )
  }

  function renderAutomaticReasoningSection() {
    return (
      <div>
        <div className="px-3 pb-1 pt-0.5 text-sm font-semibold text-text-muted">
          {t('workbench.reasoning_level')}
        </div>
        <button
          type="button"
          data-testid="model-control-reasoning-auto"
          disabled
          className="flex min-h-8 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-sm text-text-primary disabled:cursor-default"
        >
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{t('workbench.reasoning_auto')}</span>
          </span>
          <Check className="h-4 w-4 shrink-0 text-text-secondary" />
        </button>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative">
      {open && (
        <div
          className={[
            'absolute z-40 w-[min(46rem,calc(100vw-2rem))]',
            menuPositionClass,
            menuClassName,
          ].join(' ')}
        >
          <div
            ref={menuPanelRef}
            data-testid="model-selector-menu"
            className="max-h-[min(32rem,calc(100vh-8rem))] w-64 shrink-0 overflow-y-auto rounded-2xl border border-border bg-base p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
          >
            {(controlsAboveFamilies.length > 0 || activeGroup) && (
              <>
                <div className="mb-1.5 space-y-1.5">
                  {controlsAboveFamilies.map(renderControlSection)}
                  {!supportsReasoningControl && renderAutomaticReasoningSection()}
                </div>
                <div className="mx-3 mb-1.5 border-t border-border" />
              </>
            )}
            <div className="space-y-0.5">
              {familyGroups.map(group => {
                const active = group.config.id === activeGroup?.config.id
                return (
                  <button
                    ref={node => {
                      if (node) {
                        familyButtonRefs.current.set(group.config.id, node)
                      } else {
                        familyButtonRefs.current.delete(group.config.id)
                      }
                    }}
                    key={group.config.id}
                    type="button"
                    data-testid={`model-family-${group.config.id}`}
                    onMouseEnter={event => activateFamily(group.config.id, event.currentTarget)}
                    onFocus={event => activateFamily(group.config.id, event.currentTarget)}
                    onClick={event => activateFamily(group.config.id, event.currentTarget)}
                    className={[
                      'flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium',
                      active
                        ? 'bg-muted text-text-primary'
                        : 'text-text-secondary hover:bg-muted hover:text-text-primary',
                    ].join(' ')}
                  >
                    <span className="min-w-0 flex-1 truncate">{group.config.label}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
                  </button>
                )
              })}
            </div>

            {controlsBelowModels.length > 0 && (
              <>
                <div className="mx-3 my-1.5 border-t border-border" />
                {controlsBelowModels.map(renderControlSection)}
              </>
            )}
          </div>

          {activeGroup ? (
            <div
              data-testid="model-selector-submenu"
              style={{ top: submenuOffset, left: submenuLeft }}
              className="absolute max-h-[min(28rem,calc(100vh-8rem))] min-h-48 w-72 overflow-y-auto rounded-2xl border border-border bg-base p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
            >
              <div className="px-3 pb-1.5 pt-0.5 text-sm font-semibold text-text-muted">
                {t('workbench.model_version')}
              </div>
              <div className="space-y-0.5">
                {activeGroup.models.map(model => {
                  const selected =
                    model.name === selectedModel?.name && model.type === selectedModel?.type
                  return (
                    <button
                      key={`${model.type}:${model.name}`}
                      type="button"
                      data-testid={`model-option-${model.name}`}
                      onClick={() => {
                        onSelectModel(model)
                        setOpen(false)
                      }}
                      className="flex h-9 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-text-primary hover:bg-muted"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {getModelDisplayLabel(model, selectedModelOptions)}
                      </span>
                      {selected && <Check className="h-4 w-4 shrink-0 text-text-secondary" />}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : (
            <div
              data-testid="model-selector-submenu"
              style={{ top: submenuOffset, left: submenuLeft }}
              className="absolute w-72 rounded-2xl border border-border bg-base p-4 text-sm text-text-muted shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
            >
              {t('workbench.no_models')}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        data-testid="model-selector-button"
        onClick={() => {
          if (disabled) return
          setOpen(current => {
            const nextOpen = !current
            if (nextOpen) {
              setActiveFamilyId(selectedFamily ?? familyGroups[0]?.config.id ?? '')
            }
            return nextOpen
          })
        }}
        disabled={disabled}
        className={[
          'flex h-11 min-w-[44px] max-w-64 items-center gap-1 rounded-full px-2 text-sm font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
          buttonClassName,
        ].join(' ')}
        aria-expanded={open}
        aria-label={t('workbench.model_selector')}
      >
        <span className="min-w-0 truncate">{buttonLabel}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
      </button>
    </div>
  )
}
