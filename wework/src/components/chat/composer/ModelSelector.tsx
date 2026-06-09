import { Check, ChevronDown, ChevronRight, Search, X } from 'lucide-react'
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile } from '@/hooks/useIsMobile'
import {
  type ModelControlConfig,
  getControlsForModel,
  getModelDisplayLabel,
  getSelectedModelDisplayLabel,
  groupModelsByFamily,
  inferModelFamily,
} from '@/lib/model-ui'
import type {
  ModelCompatibilityDisabledReason,
  ModelOptions,
  UnifiedModel,
} from '@/types/api'
import { useOutsideClick } from './useOutsideClick'

const MAIN_MENU_WIDTH = 256
const SUBMENU_WIDTH = 288
const SUBMENU_GAP = 8
const VIEWPORT_MARGIN = 16
const DESKTOP_MENU_VIEWPORT_TOP = 64
const MAIN_MENU_TRIGGER_GAP = 20
const MAIN_MENU_MAX_HEIGHT = 608
const SUBMENU_RIGHT_OFFSET = MAIN_MENU_WIDTH + SUBMENU_GAP
const SUBMENU_MAX_HEIGHT = 448
const SUBMENU_VIEWPORT_VERTICAL_GAP = 128
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
type DesktopSubmenuTarget =
  | { type: 'family'; id: string }
  | { type: 'control'; id: string }
  | { type: 'none' }

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
  const isMobile = useIsMobile()
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuPanelRef = useRef<HTMLDivElement>(null)
  const submenuPanelRef = useRef<HTMLDivElement>(null)
  const mobileMenuRef = useRef<HTMLDivElement>(null)
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null)
  const familyButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const controlButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const [open, setOpen] = useState(false)
  const [mobileQuery, setMobileQuery] = useState('')
  const [desktopMenuTop, setDesktopMenuTop] = useState(0)
  const [desktopMenuMaxHeight, setDesktopMenuMaxHeight] = useState(MAIN_MENU_MAX_HEIGHT)
  const [submenuOffset, setSubmenuOffset] = useState(0)
  const [submenuLeft, setSubmenuLeft] = useState(SUBMENU_RIGHT_OFFSET)
  const [submenuWidth, setSubmenuWidth] = useState<number | undefined>()
  const [activeDesktopSubmenu, setActiveDesktopSubmenu] =
    useState<DesktopSubmenuTarget | null>(null)
  const familyGroups = useMemo(() => groupModelsByFamily(models), [models])
  const selectedFamily = selectedModel ? inferModelFamily(selectedModel) : familyGroups[0]?.config.id
  const [activeFamilyId, setActiveFamilyId] = useState(selectedFamily ?? '')
  const displayedFamilyId =
    activeFamilyId || selectedFamily || familyGroups[0]?.config.id || ''
  const activeGroup =
    familyGroups.find(group => group.config.id === displayedFamilyId) ?? familyGroups[0]
  const closeMenu = useCallback(() => {
    setOpen(false)
    setMobileQuery('')
    setActiveDesktopSubmenu(null)
  }, [])
  const handleSelectModelOption = useCallback(
    (optionId: string, value: string) => {
      onSelectModelOption(optionId, value)
      if (!isMobile) {
        closeMenu()
      }
    },
    [closeMenu, isMobile, onSelectModelOption],
  )
  const handleSelectModel = useCallback(
    (model: UnifiedModel | null) => {
      onSelectModel(model)
      if (!isMobile) {
        closeMenu()
      }
    },
    [closeMenu, isMobile, onSelectModel],
  )
  const updateDesktopMenuLayout = useCallback(() => {
    const container = containerRef.current
    const button = buttonRef.current
    const menuPanel = menuPanelRef.current
    if (!container || !button || !menuPanel) return

    const viewportTop = DESKTOP_MENU_VIEWPORT_TOP
    const viewportBottom = window.innerHeight - VIEWPORT_MARGIN
    const maxAvailableHeight = Math.max(0, viewportBottom - viewportTop)
    const measuredHeight = menuPanel.getBoundingClientRect().height
    const contentHeight = menuPanel.scrollHeight
    const naturalHeight =
      Math.max(measuredHeight, contentHeight) || MAIN_MENU_MAX_HEIGHT
    const menuHeight = Math.min(
      MAIN_MENU_MAX_HEIGHT,
      maxAvailableHeight,
      naturalHeight,
    )
    const buttonRect = button.getBoundingClientRect()
    const preferredTop =
      menuPlacement === 'below'
        ? buttonRect.bottom + MAIN_MENU_TRIGGER_GAP
        : buttonRect.top - MAIN_MENU_TRIGGER_GAP - menuHeight
    const maxTop = viewportBottom - menuHeight
    const clampedTop = Math.round(
      Math.max(viewportTop, Math.min(preferredTop, maxTop)),
    )
    const containerTop = container.getBoundingClientRect().top

    setDesktopMenuTop(clampedTop - containerTop)
    setDesktopMenuMaxHeight(menuHeight)
  }, [menuPlacement])
  const updateSubmenuLayout = useCallback((target: HTMLElement | null) => {
    if (!target || !menuPanelRef.current) {
      setSubmenuOffset(0)
      setSubmenuLeft(SUBMENU_RIGHT_OFFSET)
      setSubmenuWidth(undefined)
      return
    }

    const menuRect = menuPanelRef.current.getBoundingClientRect()
    const menuTop = menuRect.top
    const targetTop = target.getBoundingClientRect().top
    const preferredOffset = Math.round(targetTop - menuTop)
    const submenuRect = submenuPanelRef.current?.getBoundingClientRect()
    const submenuScrollHeight = submenuPanelRef.current?.scrollHeight ?? 0
    const maxSubmenuHeight = Math.min(
      SUBMENU_MAX_HEIGHT,
      Math.max(0, window.innerHeight - SUBMENU_VIEWPORT_VERTICAL_GAP),
    )
    const measuredSubmenuHeight = submenuRect?.height ?? 0
    const submenuHeight = Math.min(
      Math.max(measuredSubmenuHeight, submenuScrollHeight),
      maxSubmenuHeight,
    )

    if (submenuHeight > 0) {
      const viewportTop = DESKTOP_MENU_VIEWPORT_TOP
      const viewportBottom = window.innerHeight - VIEWPORT_MARGIN
      const maxOffset = viewportBottom - submenuHeight - menuTop
      const minOffset = viewportTop - menuTop
      setSubmenuOffset(
        Math.round(Math.max(minOffset, Math.min(preferredOffset, maxOffset))),
      )
    } else {
      setSubmenuOffset(preferredOffset)
    }

    const measuredMenuWidth = menuRect.width || MAIN_MENU_WIDTH
    const measuredSubmenuWidth = submenuRect?.width || SUBMENU_WIDTH
    const rightSideLeft = measuredMenuWidth + SUBMENU_GAP
    const viewportWidth = window.innerWidth
    const availableRight =
      viewportWidth - VIEWPORT_MARGIN - menuRect.left - rightSideLeft
    const availableLeft = menuRect.left - VIEWPORT_MARGIN - SUBMENU_GAP
    const rightSideWidth = Math.max(
      0,
      Math.min(measuredSubmenuWidth, availableRight),
    )
    const leftSideWidth = Math.max(
      0,
      Math.min(measuredSubmenuWidth, availableLeft),
    )

    const rightSideEdge = menuRect.left + rightSideLeft + measuredSubmenuWidth
    if (rightSideEdge <= viewportWidth - VIEWPORT_MARGIN) {
      setSubmenuWidth(undefined)
      setSubmenuLeft(rightSideLeft)
      return
    }

    const leftSideLeft = -(measuredSubmenuWidth + SUBMENU_GAP)
    if (menuRect.left + leftSideLeft >= VIEWPORT_MARGIN) {
      setSubmenuWidth(undefined)
      setSubmenuLeft(leftSideLeft)
      return
    }

    if (leftSideWidth >= rightSideWidth) {
      setSubmenuWidth(Math.round(leftSideWidth))
      setSubmenuLeft(-Math.round(leftSideWidth + SUBMENU_GAP))
      return
    }

    if (rightSideWidth > 0) {
      setSubmenuWidth(Math.round(rightSideWidth))
      setSubmenuLeft(rightSideLeft)
      return
    }

    const viewportFittedLeft = Math.max(
      VIEWPORT_MARGIN - menuRect.left,
      Math.min(
        rightSideLeft,
        viewportWidth - VIEWPORT_MARGIN - measuredSubmenuWidth - menuRect.left,
      ),
    )
    setSubmenuWidth(undefined)
    setSubmenuLeft(Math.round(viewportFittedLeft))
  }, [])
  const activateFamily = useCallback(
    (familyId: string, target?: HTMLElement | null) => {
      setActiveFamilyId(current => (current === familyId ? current : familyId))
      setActiveDesktopSubmenu({ type: 'family', id: familyId })
      updateSubmenuLayout(target ?? familyButtonRefs.current.get(familyId) ?? null)
    },
    [updateSubmenuLayout],
  )
  const activateControl = useCallback(
    (controlId: string, target?: HTMLElement | null) => {
      setActiveDesktopSubmenu({ type: 'control', id: controlId })
      updateSubmenuLayout(target ?? controlButtonRefs.current.get(controlId) ?? null)
    },
    [updateSubmenuLayout],
  )
  const clearDesktopSubmenu = useCallback(() => {
    setActiveDesktopSubmenu({ type: 'none' })
  }, [])
  const activateMobileFamily = useCallback((familyId: string) => {
    setActiveFamilyId(current => (current === familyId ? current : familyId))
  }, [])

  useOutsideClick(containerRef, open && !isMobile, closeMenu)

  useLayoutEffect(() => {
    if (!open) return
    if (activeDesktopSubmenu?.type === 'control') {
      updateSubmenuLayout(
        controlButtonRefs.current.get(activeDesktopSubmenu.id) ?? null,
      )
      return
    }
    updateSubmenuLayout(familyButtonRefs.current.get(displayedFamilyId) ?? null)
  }, [activeDesktopSubmenu, displayedFamilyId, open, updateSubmenuLayout])

  useEffect(() => {
    if (!open || !isMobile) return
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    mobileCloseButtonRef.current?.focus()
    return () => {
      previousActiveElement?.focus()
    }
  }, [isMobile, open])

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
  const activeControl =
    activeDesktopSubmenu?.type === 'control'
      ? controlsBelowModels.find(control => control.id === activeDesktopSubmenu.id)
      : undefined

  useLayoutEffect(() => {
    if (!open || isMobile) return

    updateDesktopMenuLayout()
    window.addEventListener('resize', updateDesktopMenuLayout)
    return () => window.removeEventListener('resize', updateDesktopMenuLayout)
  }, [
    activeGroup?.models.length,
    controlsAboveFamilies.length,
    controlsBelowModels.length,
    familyGroups.length,
    isMobile,
    open,
    updateDesktopMenuLayout,
  ])

  const normalizedMobileQuery = mobileQuery.trim().toLowerCase()
  const resolveControlLabel = useCallback(
    (key: string, fallback: string) => t(key, fallback),
    [t],
  )
  const mobileModels = useMemo(() => {
    const modelsToFilter = activeGroup?.models ?? []
    if (!normalizedMobileQuery) return modelsToFilter

    return modelsToFilter.filter(model => {
      const searchableText = [
        model.name,
        model.displayName,
        model.modelId,
        getModelDisplayLabel(model, selectedModelOptions, resolveControlLabel),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return searchableText.includes(normalizedMobileQuery)
    })
  }, [activeGroup, normalizedMobileQuery, resolveControlLabel, selectedModelOptions])

  function renderControlSection(control: ModelControlConfig) {
    return (
      <div
        key={control.id}
        onMouseEnter={clearDesktopSubmenu}
        onPointerEnter={clearDesktopSubmenu}
      >
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
                  onFocus={clearDesktopSubmenu}
                  onClick={() => handleSelectModelOption(control.id, option.value)}
                  className="flex min-h-8 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-sm text-text-primary hover:bg-muted"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      {option.labelKey ? t(option.labelKey) : option.label}
                    </span>
                    {option.description && (
                      <span className="mt-0.5 block text-xs text-text-muted">
                        {option.descriptionKey
                          ? t(option.descriptionKey, option.description)
                          : option.description}
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

  function renderControlTrigger(control: ModelControlConfig) {
    const active =
      activeDesktopSubmenu?.type === 'control' &&
      activeDesktopSubmenu.id === control.id
    return (
      <button
        ref={node => {
          if (node) {
            controlButtonRefs.current.set(control.id, node)
          } else {
            controlButtonRefs.current.delete(control.id)
          }
        }}
        key={control.id}
        type="button"
        data-testid={`model-control-trigger-${control.id}`}
        onMouseEnter={event => activateControl(control.id, event.currentTarget)}
        onPointerEnter={event => activateControl(control.id, event.currentTarget)}
        onFocus={event => activateControl(control.id, event.currentTarget)}
        onClick={event => activateControl(control.id, event.currentTarget)}
        className={[
          'flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-[13px] font-medium leading-[18px]',
          active
            ? 'bg-muted text-text-primary'
            : 'text-text-secondary hover:bg-muted hover:text-text-primary',
        ].join(' ')}
      >
        <span className="min-w-0 flex-1 truncate">
          {control.labelKey ? t(control.labelKey, control.label) : control.label}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
      </button>
    )
  }

  function renderDesktopControlSubmenu(control: ModelControlConfig) {
    return (
      <div
        ref={submenuPanelRef}
        data-testid={`model-control-submenu-${control.id}`}
        style={{ top: submenuOffset, left: submenuLeft, width: submenuWidth }}
        className="absolute w-72 rounded-2xl border border-border bg-background p-4 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
      >
        <div className="pb-3 text-[13px] font-semibold leading-[18px] text-text-muted">
          {control.labelKey ? t(control.labelKey, control.label) : control.label}
        </div>
        <div className="space-y-1">
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
                  className="flex min-h-12 w-full items-start gap-3 rounded-lg px-2 py-2 text-left text-[13px] leading-[18px] text-text-primary hover:bg-muted"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">
                      {option.labelKey ? t(option.labelKey, option.label) : option.label}
                    </span>
                    {(option.description || option.descriptionKey) && (
                      <span className="mt-0.5 block text-xs font-medium text-text-muted">
                        {option.descriptionKey
                          ? t(option.descriptionKey, option.description ?? '')
                          : option.description}
                      </span>
                    )}
                  </span>
                  {selected && (
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
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

  function renderMobileControlSection(control: ModelControlConfig) {
    return (
      <section key={control.id} className="space-y-2">
        <h3 className="px-1 text-xs font-semibold text-text-muted">
          {control.labelKey ? t(control.labelKey) : control.label}
        </h3>
        <div className="scrollbar-none flex gap-2 overflow-x-auto pb-1">
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
                  className={[
                    'flex h-11 min-w-[44px] shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium',
                    selected
                      ? 'border-[#1f2933] bg-[#1f2933] text-white'
                      : 'border-border bg-surface text-text-secondary',
                  ].join(' ')}
                >
                  <span>{option.labelKey ? t(option.labelKey) : option.label}</span>
                  {selected && <Check className="h-4 w-4" />}
                </button>
              )
            })}
        </div>
      </section>
    )
  }

  function renderMobileAutomaticReasoningSection() {
    return (
      <section className="space-y-2">
        <h3 className="px-1 text-xs font-semibold text-text-muted">
          {t('workbench.reasoning_level')}
        </h3>
        <button
          type="button"
          data-testid="model-control-reasoning-auto"
          disabled
          className="flex h-11 min-w-[44px] items-center gap-2 rounded-full border border-[#1f2933] bg-[#1f2933] px-4 text-sm font-medium text-white disabled:cursor-default"
        >
          <span>{t('workbench.reasoning_auto')}</span>
          <Check className="h-4 w-4" />
        </button>
      </section>
    )
  }

  function handleMobileDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      closeMenu()
      return
    }
    if (event.key !== 'Tab' || !mobileMenuRef.current) return

    const focusableElements = Array.from(
      mobileMenuRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter(element => element.offsetParent !== null)
    if (focusableElements.length === 0) return

    const firstElement = focusableElements[0]
    const lastElement = focusableElements[focusableElements.length - 1]
    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault()
      lastElement.focus()
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault()
      firstElement.focus()
    }
  }

  function renderMobileSheet() {
    return createPortal(
      <div
        className="fixed inset-0 z-modal bg-black/25"
        onClick={closeMenu}
      >
        <div
          ref={mobileMenuRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="model-selector-mobile-title"
          data-testid="model-selector-menu"
          data-mobile="true"
          className="absolute inset-x-0 bottom-0 flex h-[82dvh] flex-col rounded-t-[28px] border border-border bg-background shadow-[0_-18px_48px_rgba(0,0,0,0.18)]"
          onClick={event => event.stopPropagation()}
          onKeyDown={handleMobileDialogKeyDown}
        >
          <div className="mx-auto mt-3 h-1 w-11 rounded-full bg-border" />
          <div className="flex items-center justify-between px-5 pb-3 pt-4">
            <div className="min-w-0">
              <h2
                id="model-selector-mobile-title"
                className="text-lg font-semibold text-text-primary"
              >
                {t('workbench.model_picker_title')}
              </h2>
              <p className="mt-1 truncate text-xs text-text-muted">{buttonLabel}</p>
            </div>
            <button
              type="button"
              ref={mobileCloseButtonRef}
              data-testid="model-selector-close-button"
              aria-label={t('workbench.close_menu')}
              onClick={closeMenu}
              className="flex h-11 w-11 items-center justify-center rounded-full bg-surface text-text-primary"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="px-5">
            <label className="flex h-11 items-center gap-3 rounded-2xl bg-surface px-4 text-text-secondary">
              <Search className="h-5 w-5 shrink-0" />
              <input
                data-testid="model-selector-search-input"
                value={mobileQuery}
                onChange={event => setMobileQuery(event.target.value)}
                placeholder={t('workbench.search_models')}
                className="min-w-0 flex-1 bg-transparent text-base leading-5 text-text-primary outline-none placeholder:text-text-muted"
              />
            </label>
          </div>

          <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-5">
            <div className="mb-5 shrink-0 space-y-4">
              {controlsAboveFamilies.map(renderMobileControlSection)}
              {!supportsReasoningControl && renderMobileAutomaticReasoningSection()}
            </div>

            <div className="scrollbar-none -mx-5 mb-5 shrink-0 overflow-x-auto px-5">
              <div className="flex gap-2">
                {familyGroups.map(group => {
                  const active = group.config.id === activeGroup?.config.id
                  return (
                    <button
                      key={group.config.id}
                      type="button"
                      data-testid={`model-family-${group.config.id}`}
                      onClick={() => activateMobileFamily(group.config.id)}
                      className={[
                        'h-11 min-w-[44px] shrink-0 rounded-full px-4 text-sm font-medium',
                        active
                          ? 'bg-[#1f2933] text-white'
                          : 'bg-surface text-text-secondary',
                      ].join(' ')}
                    >
                      {group.config.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <section className="flex min-h-0 flex-1 flex-col space-y-2" data-testid="model-selector-submenu">
              <h3 className="shrink-0 px-1 text-xs font-semibold text-text-muted">
                {activeGroup?.config.label ?? t('workbench.model_version')}
              </h3>
              {mobileModels.length > 0 ? (
                <div
                  data-testid="model-selector-model-list"
                  className="scrollbar-none min-h-0 flex-1 space-y-2 overflow-y-auto pb-2"
                >
                  {mobileModels.map(model => {
                    const selected =
                      model.name === selectedModel?.name && model.type === selectedModel?.type
                    const modelDisabled = Boolean(model.compatibilityDisabled)
                    const disabledMessage = modelDisabled
                      ? getCompatibilityDisabledMessage(model.compatibilityDisabledReason)
                      : undefined
                    return (
                      <button
                        key={`${model.type}:${model.name}`}
                        type="button"
                        data-testid={`model-option-${model.name}`}
                        disabled={modelDisabled}
                        aria-disabled={modelDisabled}
                        title={disabledMessage}
                        onClick={() => {
                          if (modelDisabled) return
                          handleSelectModel(model)
                        }}
                        className={[
                          'flex min-h-14 w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left disabled:cursor-not-allowed disabled:opacity-70',
                          selected
                            ? 'border-[#b9d1ca] bg-[#e8f2ef]'
                            : 'border-transparent bg-surface disabled:bg-surface',
                        ].join(' ')}
                      >
                        <span className="min-w-0 flex-1">
                          <span
                            className={[
                              'block truncate text-sm font-semibold',
                              modelDisabled ? 'text-text-muted' : 'text-text-primary',
                            ].join(' ')}
                          >
                            {getModelDisplayLabel(
                              model,
                              selectedModelOptions,
                              resolveControlLabel,
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-text-muted">
                            {disabledMessage ||
                              model.displayName ||
                              model.modelId ||
                              model.name}
                          </span>
                        </span>
                        {selected && (
                          <Check className="h-5 w-5 shrink-0 text-text-primary" />
                        )}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="rounded-2xl bg-surface px-4 py-6 text-center text-sm text-text-muted">
                  {t('workbench.no_models')}
                </div>
              )}
            </section>

            {controlsBelowModels.length > 0 && (
              <div className="mt-5 space-y-4">
                {controlsBelowModels.map(renderMobileControlSection)}
              </div>
            )}
          </div>

          <div className="flex shrink-0 gap-3 border-t border-border bg-background/95 px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
            <button
              type="button"
              data-testid="model-selector-auto-button"
              onClick={() => handleSelectModel(null)}
              className="h-11 flex-1 rounded-full border border-border bg-background text-sm font-semibold text-text-primary"
            >
              {t('workbench.model_auto_select')}
            </button>
            <button
              type="button"
              data-testid="model-selector-confirm-button"
              onClick={closeMenu}
              className="h-11 flex-1 rounded-full bg-[#1f2933] text-sm font-semibold text-white"
            >
              {t('workbench.use_current_model')}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    )
  }

  function getCompatibilityDisabledMessage(
    reason?: ModelCompatibilityDisabledReason,
  ): string {
    if (reason === 'missing_current_runtime_family') {
      return t(
        'workbench.model_disabled_missing_current_runtime_family',
        'Current model is missing runtime.family',
      )
    }
    if (reason === 'missing_target_runtime_family') {
      return t(
        'workbench.model_disabled_missing_target_runtime_family',
        'This model is missing runtime.family',
      )
    }
    return t(
      'workbench.model_disabled_runtime_family_mismatch',
      'Incompatible with the current model protocol',
    )
  }

  return (
    <div ref={containerRef} className="relative">
      {open && isMobile && renderMobileSheet()}
      {open && !isMobile && (
        <div
          style={{ top: desktopMenuTop }}
          className={[
            'absolute left-0 z-popover w-[min(46rem,calc(100vw-2rem))]',
            menuClassName,
          ].join(' ')}
        >
          <div
            ref={menuPanelRef}
            data-testid="model-selector-menu"
            style={{ maxHeight: desktopMenuMaxHeight }}
            className="w-64 shrink-0 overflow-y-auto rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
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
                const active =
                  activeDesktopSubmenu?.type === 'family' &&
                  group.config.id === activeGroup?.config.id
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
                    onPointerEnter={event => activateFamily(group.config.id, event.currentTarget)}
                    onFocus={event => activateFamily(group.config.id, event.currentTarget)}
                    onClick={event => activateFamily(group.config.id, event.currentTarget)}
                    className={[
                      'flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-[13px] font-medium leading-[18px]',
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
                <div className="space-y-0.5">
                  {controlsBelowModels.map(renderControlTrigger)}
                </div>
              </>
            )}
          </div>

          {activeControl ? (
            renderDesktopControlSubmenu(activeControl)
          ) : activeGroup ? (
            <div
              ref={submenuPanelRef}
              data-testid="model-selector-submenu"
              style={{ top: submenuOffset, left: submenuLeft, width: submenuWidth }}
              className="absolute max-h-[min(28rem,calc(100vh-8rem))] min-h-48 w-72 overflow-y-auto rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
            >
              <div className="px-3 pb-1.5 pt-0.5 text-[13px] font-semibold leading-[18px] text-text-muted">
                {t('workbench.model_version')}
              </div>
              <div className="space-y-0.5">
                {activeGroup.models.map(model => {
                  const selected =
                    model.name === selectedModel?.name && model.type === selectedModel?.type
                  const modelDisabled = Boolean(model.compatibilityDisabled)
                  const disabledMessage = modelDisabled
                    ? getCompatibilityDisabledMessage(model.compatibilityDisabledReason)
                    : undefined
                  return (
                    <button
                      key={`${model.type}:${model.name}`}
                      type="button"
                      data-testid={`model-option-${model.name}`}
                      disabled={modelDisabled}
                      aria-disabled={modelDisabled}
                      title={disabledMessage}
                      onClick={() => {
                        if (modelDisabled) return
                        handleSelectModel(model)
                      }}
                      className="flex min-h-9 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-[13px] leading-[18px] text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:text-text-muted disabled:hover:bg-transparent"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {disabledMessage ? (
                          <>
                            <span className="block truncate">
                              {getModelDisplayLabel(
                                model,
                                selectedModelOptions,
                                resolveControlLabel,
                              )}
                            </span>
                            <span className="mt-0.5 block truncate text-xs font-normal text-text-muted">
                              {disabledMessage}
                            </span>
                          </>
                        ) : (
                          getModelDisplayLabel(
                            model,
                            selectedModelOptions,
                            resolveControlLabel,
                          )
                        )}
                      </span>
                      {selected && <Check className="h-4 w-4 shrink-0 text-text-secondary" />}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : (
            <div
              ref={submenuPanelRef}
              data-testid="model-selector-submenu"
              style={{ top: submenuOffset, left: submenuLeft, width: submenuWidth }}
              className="absolute w-72 rounded-2xl border border-border bg-background p-4 text-[13px] leading-[18px] text-text-muted shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
            >
              {t('workbench.no_models')}
            </div>
          )}
        </div>
      )}
      <button
        ref={buttonRef}
        type="button"
        data-testid="model-selector-button"
        onClick={() => {
          if (disabled) return
          setOpen(current => {
            const nextOpen = !current
            if (nextOpen) {
              const initialFamilyId = selectedFamily ?? familyGroups[0]?.config.id ?? ''
              setActiveFamilyId(initialFamilyId)
              setActiveDesktopSubmenu(
                initialFamilyId ? { type: 'family', id: initialFamilyId } : null,
              )
            }
            return nextOpen
          })
        }}
        disabled={disabled}
        className={[
          'flex h-8 min-w-8 items-center gap-1 rounded-full px-2 text-[13px] font-medium leading-[18px] text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
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
