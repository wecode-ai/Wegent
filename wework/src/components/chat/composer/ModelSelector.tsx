import { Check, ChevronDown, ChevronRight, Search, X } from 'lucide-react'
import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
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
  normalizeModelOptionValue,
} from '@/lib/model-ui'
import { cn } from '@/lib/utils'
import type { ModelCompatibilityDisabledReason, ModelOptions, UnifiedModel } from '@/types/api'

const MAIN_MENU_WIDTH = 256
const SUBMENU_WIDTH = 288
const SUBMENU_GAP = 0
const VIEWPORT_MARGIN = 16
const DESKTOP_MENU_VIEWPORT_TOP = 64
const MAIN_MENU_TRIGGER_GAP = 8
const MAIN_MENU_MAX_HEIGHT = 608
const SUBMENU_RIGHT_OFFSET = MAIN_MENU_WIDTH + SUBMENU_GAP
const SUBMENU_MAX_HEIGHT = 448
const SUBMENU_VIEWPORT_VERTICAL_GAP = 128
const REASONING_TRACK_EDGE_PADDING = 12
const POINTER_DRAG_THRESHOLD = 3
const DESKTOP_HIDDEN_CONTROL_IDS = new Set(['collaborationMode'])
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
type DesktopSubmenuTarget =
  | { type: 'family'; id: string }
  | { type: 'control'; id: string }
  | { type: 'none' }

function isVisibleModelSelectorControl(control: ModelControlConfig): boolean {
  return control.id !== 'collaborationMode'
}

interface ModelSelectorProps {
  models: UnifiedModel[]
  selectedModel: UnifiedModel | null
  selectedModelOptions: ModelOptions
  disabled: boolean
  onSelectModel: (model: UnifiedModel | null) => void
  onSelectModelOption: (optionId: string, value: string) => void
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
  openSignal?: number
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
  onBlockedModelSelect,
  openSignal,
  menuPlacement = 'above',
  buttonClassName = '',
  menuClassName = '',
}: ModelSelectorProps) {
  const { t } = useTranslation('common')
  const isMobile = useIsMobile()
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const desktopMenuWrapperRef = useRef<HTMLDivElement>(null)
  const menuPanelRef = useRef<HTMLDivElement>(null)
  const submenuPanelRef = useRef<HTMLDivElement>(null)
  const mobileMenuRef = useRef<HTMLDivElement>(null)
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null)
  const handledOpenSignalRef = useRef<number | undefined>(undefined)
  const reasoningDragActiveRef = useRef(false)
  const reasoningDragMovedRef = useRef(false)
  const reasoningDragStartXRef = useRef(0)
  const reasoningDragSuppressClickRef = useRef(false)
  const reasoningDragValueRef = useRef<string | null>(null)
  const familyButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const controlButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const [open, setOpen] = useState(false)
  const [mobileQuery, setMobileQuery] = useState('')
  const [desktopMenuTop, setDesktopMenuTop] = useState(0)
  const [desktopMenuLeft, setDesktopMenuLeft] = useState(0)
  const [desktopMenuMaxHeight, setDesktopMenuMaxHeight] = useState(MAIN_MENU_MAX_HEIGHT)
  const [submenuOffset, setSubmenuOffset] = useState(0)
  const [submenuLeft, setSubmenuLeft] = useState(SUBMENU_RIGHT_OFFSET)
  const [submenuWidth, setSubmenuWidth] = useState<number | undefined>()
  const [activeDesktopSubmenu, setActiveDesktopSubmenu] = useState<DesktopSubmenuTarget | null>(
    null
  )
  const familyGroups = useMemo(() => groupModelsByFamily(models), [models])
  const selectedFamily = selectedModel
    ? inferModelFamily(selectedModel)
    : familyGroups[0]?.config.id
  const [activeFamilyId, setActiveFamilyId] = useState(selectedFamily ?? '')
  const displayedFamilyId = activeFamilyId || selectedFamily || familyGroups[0]?.config.id || ''
  const activeGroup =
    familyGroups.find(group => group.config.id === displayedFamilyId) ?? familyGroups[0]

  useEffect(() => {
    if (!openSignal || disabled || open) return
    if (handledOpenSignalRef.current === openSignal) return

    handledOpenSignalRef.current = openSignal
    buttonRef.current?.click()
  }, [disabled, open, openSignal])

  const closeMenu = useCallback(() => {
    setOpen(false)
    setMobileQuery('')
    setActiveDesktopSubmenu(null)
  }, [setActiveDesktopSubmenu, setMobileQuery, setOpen])
  const handleSelectModelOption = useCallback(
    (optionId: string, value: string) => {
      onSelectModelOption(optionId, value)
      if (!isMobile) {
        closeMenu()
      }
    },
    [closeMenu, isMobile, onSelectModelOption]
  )
  const handleSelectModel = useCallback(
    (model: UnifiedModel | null) => {
      onSelectModel(model)
      if (!isMobile) {
        closeMenu()
      }
    },
    [closeMenu, isMobile, onSelectModel]
  )
  const updateDesktopMenuLayout = useCallback(() => {
    const button = buttonRef.current
    const menuPanel = menuPanelRef.current
    if (!button || !menuPanel) return

    const viewportTop = DESKTOP_MENU_VIEWPORT_TOP
    const viewportBottom = window.innerHeight - VIEWPORT_MARGIN
    const maxAvailableHeight = Math.max(0, viewportBottom - viewportTop)
    const measuredHeight = menuPanel.getBoundingClientRect().height
    const contentHeight = menuPanel.scrollHeight
    const naturalHeight = Math.max(measuredHeight, contentHeight) || MAIN_MENU_MAX_HEIGHT
    const menuHeight = Math.min(MAIN_MENU_MAX_HEIGHT, maxAvailableHeight, naturalHeight)
    const buttonRect = button.getBoundingClientRect()
    const preferredTop =
      menuPlacement === 'below'
        ? buttonRect.bottom + MAIN_MENU_TRIGGER_GAP
        : buttonRect.top - MAIN_MENU_TRIGGER_GAP - menuHeight
    const maxTop = viewportBottom - menuHeight
    const clampedTop = Math.round(Math.max(viewportTop, Math.min(preferredTop, maxTop)))
    const menuWidth = menuPanel.getBoundingClientRect().width || MAIN_MENU_WIDTH
    const maxLeft = window.innerWidth - VIEWPORT_MARGIN - menuWidth
    const preferredLeft = buttonRect.right - menuWidth
    const clampedLeft = Math.round(Math.max(VIEWPORT_MARGIN, Math.min(preferredLeft, maxLeft)))

    setDesktopMenuTop(clampedTop)
    setDesktopMenuLeft(clampedLeft)
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
      Math.max(0, window.innerHeight - SUBMENU_VIEWPORT_VERTICAL_GAP)
    )
    const measuredSubmenuHeight = submenuRect?.height ?? 0
    const submenuHeight = Math.min(
      Math.max(measuredSubmenuHeight, submenuScrollHeight),
      maxSubmenuHeight
    )

    if (submenuHeight > 0) {
      const viewportTop = DESKTOP_MENU_VIEWPORT_TOP
      const viewportBottom = window.innerHeight - VIEWPORT_MARGIN
      const maxOffset = viewportBottom - submenuHeight - menuTop
      const minOffset = viewportTop - menuTop
      setSubmenuOffset(Math.round(Math.max(minOffset, Math.min(preferredOffset, maxOffset))))
    } else {
      setSubmenuOffset(preferredOffset)
    }

    const measuredMenuWidth = menuRect.width || MAIN_MENU_WIDTH
    const measuredSubmenuWidth = submenuRect?.width || SUBMENU_WIDTH
    const rightSideLeft = measuredMenuWidth + SUBMENU_GAP
    const viewportWidth = window.innerWidth
    const availableRight = viewportWidth - VIEWPORT_MARGIN - menuRect.left - rightSideLeft
    const availableLeft = menuRect.left - VIEWPORT_MARGIN - SUBMENU_GAP
    const rightSideWidth = Math.max(0, Math.min(measuredSubmenuWidth, availableRight))
    const leftSideWidth = Math.max(0, Math.min(measuredSubmenuWidth, availableLeft))

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
        viewportWidth - VIEWPORT_MARGIN - measuredSubmenuWidth - menuRect.left
      )
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
    [setActiveDesktopSubmenu, setActiveFamilyId, updateSubmenuLayout]
  )
  const activateControl = useCallback(
    (controlId: string, target?: HTMLElement | null) => {
      setActiveDesktopSubmenu({ type: 'control', id: controlId })
      updateSubmenuLayout(target ?? controlButtonRefs.current.get(controlId) ?? null)
    },
    [setActiveDesktopSubmenu, updateSubmenuLayout]
  )
  const clearDesktopSubmenu = useCallback(() => {
    setActiveDesktopSubmenu({ type: 'none' })
  }, [setActiveDesktopSubmenu])
  const activateMobileFamily = useCallback(
    (familyId: string) => {
      setActiveFamilyId(current => (current === familyId ? current : familyId))
    },
    [setActiveFamilyId]
  )

  useEffect(() => {
    if (!open || isMobile) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (
        containerRef.current?.contains(target) ||
        desktopMenuWrapperRef.current?.contains(target)
      ) {
        return
      }

      closeMenu()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [closeMenu, isMobile, open])

  useLayoutEffect(() => {
    if (!open) return
    if (activeDesktopSubmenu?.type === 'family') {
      updateSubmenuLayout(familyButtonRefs.current.get(activeDesktopSubmenu.id) ?? null)
      return
    }
    if (activeDesktopSubmenu?.type === 'control') {
      updateSubmenuLayout(controlButtonRefs.current.get(activeDesktopSubmenu.id) ?? null)
      return
    }
    updateSubmenuLayout(null)
  }, [activeDesktopSubmenu, open, updateSubmenuLayout])

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
    getSelectedModelDisplayLabel(selectedModel, selectedModelOptions, (key, fallback) =>
      t(key, fallback)
    ) || t('workbench.default_model')
  const controlsAboveFamilies = useMemo(() => {
    const controls = selectedModel
      ? getControlsForModel(selectedModel)
      : (activeGroup?.config.controls ?? [])
    return controls.filter(
      control => isVisibleModelSelectorControl(control) && (control.scope ?? 'family') === 'family'
    )
  }, [activeGroup, selectedModel])
  const supportsReasoningControl = controlsAboveFamilies.some(control => control.id === 'reasoning')
  const selectedModelControls = selectedModel
    ? getControlsForModel(selectedModel).filter(
        control => isVisibleModelSelectorControl(control) && control.scope === 'model'
      )
    : []
  const controlsBelowModels = selectedModelControls.filter(
    control => control.placement === 'belowModels'
  )
  const desktopControlsAboveFamilies = controlsAboveFamilies.filter(
    control => !DESKTOP_HIDDEN_CONTROL_IDS.has(control.id)
  )
  const desktopControlsBelowModels = controlsBelowModels.filter(
    control => !DESKTOP_HIDDEN_CONTROL_IDS.has(control.id)
  )
  const activeControl =
    activeDesktopSubmenu?.type === 'control'
      ? desktopControlsBelowModels.find(control => control.id === activeDesktopSubmenu.id)
      : undefined
  const activeFamilySubmenuGroup = activeDesktopSubmenu?.type === 'family' ? activeGroup : undefined

  useLayoutEffect(() => {
    if (!open || isMobile) return

    updateDesktopMenuLayout()
    window.addEventListener('resize', updateDesktopMenuLayout)
    return () => window.removeEventListener('resize', updateDesktopMenuLayout)
  }, [
    activeGroup?.models.length,
    desktopControlsAboveFamilies.length,
    desktopControlsBelowModels.length,
    familyGroups.length,
    isMobile,
    open,
    updateDesktopMenuLayout,
  ])

  const normalizedMobileQuery = mobileQuery.trim().toLowerCase()
  const resolveControlLabel = useCallback((key: string, fallback: string) => t(key, fallback), [t])
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

  function renderControlSection(
    control: ModelControlConfig,
    { clearSubmenuOnHover = true }: { clearSubmenuOnHover?: boolean } = {}
  ) {
    if (control.id === 'reasoning') {
      return renderReasoningSlider(control, { clearSubmenuOnHover })
    }

    return (
      <div
        key={control.id}
        onMouseEnter={clearSubmenuOnHover ? clearDesktopSubmenu : undefined}
        onPointerEnter={clearSubmenuOnHover ? clearDesktopSubmenu : undefined}
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
                (normalizeModelOptionValue(control.id, selectedModelOptions[control.id]) ??
                  control.defaultValue) === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  data-testid={`model-control-${control.id}-${option.value}`}
                  onFocus={clearSubmenuOnHover ? clearDesktopSubmenu : undefined}
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
                  {selected && <Check className="h-4 w-4 shrink-0 text-text-secondary" />}
                </button>
              )
            })}
        </div>
      </div>
    )
  }

  function reasoningSliderPosition(index: number, count: number): string {
    if (count <= 1) return '50%'
    if (index === 0) return '12px'
    if (index === count - 1) return 'calc(100% - 12px)'
    return `${(index / (count - 1)) * 100}%`
  }

  function renderReasoningSlider(
    control: ModelControlConfig,
    { clearSubmenuOnHover = true }: { clearSubmenuOnHover?: boolean } = {}
  ) {
    const options = control.options.slice().sort((a, b) => a.order - b.order)
    const selectedValue =
      normalizeModelOptionValue(control.id, selectedModelOptions[control.id]) ??
      control.defaultValue
    const selectedIndex = Math.max(
      0,
      options.findIndex(option => option.value === selectedValue)
    )
    const selectReasoningOptionFromClientX = (track: HTMLElement, clientX: number) => {
      if (options.length === 0) return

      const rect = track.getBoundingClientRect()
      const trackStart = rect.left + REASONING_TRACK_EDGE_PADDING
      const trackEnd = rect.right - REASONING_TRACK_EDGE_PADDING
      const trackWidth = Math.max(1, trackEnd - trackStart)
      const ratio = Math.max(0, Math.min(1, (clientX - trackStart) / trackWidth))
      const optionIndex = options.length === 1 ? 0 : Math.round(ratio * (options.length - 1))
      const optionValue = options[optionIndex]?.value
      if (!optionValue || reasoningDragValueRef.current === optionValue) return

      reasoningDragValueRef.current = optionValue
      onSelectModelOption(control.id, optionValue)
    }
    const startReasoningDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return

      reasoningDragActiveRef.current = true
      reasoningDragMovedRef.current = false
      reasoningDragStartXRef.current = event.clientX
      reasoningDragSuppressClickRef.current = false
      reasoningDragValueRef.current = null
      event.currentTarget.setPointerCapture?.(event.pointerId)
      selectReasoningOptionFromClientX(event.currentTarget, event.clientX)
    }
    const updateReasoningDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!reasoningDragActiveRef.current) return

      if (Math.abs(event.clientX - reasoningDragStartXRef.current) >= POINTER_DRAG_THRESHOLD) {
        reasoningDragMovedRef.current = true
        reasoningDragSuppressClickRef.current = true
      }
      selectReasoningOptionFromClientX(event.currentTarget, event.clientX)
    }
    const finishReasoningDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!reasoningDragActiveRef.current) return

      selectReasoningOptionFromClientX(event.currentTarget, event.clientX)
      reasoningDragActiveRef.current = false
      reasoningDragValueRef.current = null
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      reasoningDragSuppressClickRef.current = reasoningDragMovedRef.current
      reasoningDragMovedRef.current = false
    }
    const cancelReasoningDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!reasoningDragActiveRef.current) return

      reasoningDragActiveRef.current = false
      reasoningDragMovedRef.current = false
      reasoningDragSuppressClickRef.current = false
      reasoningDragValueRef.current = null
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    }
    const suppressClickAfterDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!reasoningDragSuppressClickRef.current) return

      reasoningDragSuppressClickRef.current = false
      event.preventDefault()
      event.stopPropagation()
    }

    return (
      <div
        key={control.id}
        data-testid="model-control-reasoning-slider"
        onMouseEnter={clearSubmenuOnHover ? clearDesktopSubmenu : undefined}
        onPointerEnter={clearSubmenuOnHover ? clearDesktopSubmenu : undefined}
        className="px-3 pb-2 pt-1"
      >
        <div className="mb-2 flex items-center justify-between text-[13px] font-medium leading-[18px] text-text-secondary">
          <span>{t('workbench.reasoning_faster', 'Faster')}</span>
          <span>{t('workbench.reasoning_smarter', 'Smarter')}</span>
        </div>
        <div
          data-testid="model-control-reasoning-track"
          className="relative h-8 cursor-pointer touch-none"
          onPointerDown={startReasoningDrag}
          onPointerMove={updateReasoningDrag}
          onPointerUp={finishReasoningDrag}
          onPointerCancel={cancelReasoningDrag}
          onClickCapture={suppressClickAfterDrag}
        >
          <div className="absolute inset-x-0 top-1/2 h-5 -translate-y-1/2 rounded-full bg-[#b77dff] shadow-[0_0_18px_rgba(183,125,255,0.45)]" />
          {options.map((option, index) => {
            const label = option.labelKey ? t(option.labelKey, option.label) : option.label
            const left = reasoningSliderPosition(index, options.length)
            const selected = index === selectedIndex

            return (
              <button
                key={option.value}
                type="button"
                data-testid={`model-control-${control.id}-${option.value}`}
                aria-label={label}
                title={label}
                onFocus={clearSubmenuOnHover ? clearDesktopSubmenu : undefined}
                onClick={() => handleSelectModelOption(control.id, option.value)}
                className="group absolute top-1/2 z-10 h-8 w-8 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[#d2adff]"
                style={{ left }}
              >
                <span
                  className={[
                    'absolute left-1/2 top-1/2 block -translate-x-1/2 -translate-y-1/2 rounded-full',
                    selected
                      ? 'h-6 w-6 border border-[#c999ff] bg-[#2d3437] shadow-[0_0_16px_rgba(183,125,255,0.78)]'
                      : 'h-1.5 w-1.5 bg-[#dec3ff]/70',
                  ].join(' ')}
                />
                <span className="pointer-events-none absolute bottom-9 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-[#252b2f] px-2 py-1 text-xs font-medium leading-none text-white shadow-[0_8px_24px_rgba(0,0,0,0.22)] group-hover:block group-focus-visible:block">
                  {label}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  function renderControlMenuItem(control: ModelControlConfig) {
    const active =
      activeDesktopSubmenu?.type === 'control' && activeDesktopSubmenu.id === control.id

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
        data-testid={`model-control-menu-${control.id}`}
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
          {control.labelKey ? t(control.labelKey) : control.label}
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
      </button>
    )
  }

  function getFamilyMenuLabel(group: (typeof familyGroups)[number]): string {
    const modelForLabel =
      selectedModel && selectedFamily === group.config.id ? selectedModel : group.models[0]
    return modelForLabel
      ? getModelDisplayLabel(modelForLabel, {}, resolveControlLabel) || group.config.label
      : group.config.label
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
                (normalizeModelOptionValue(control.id, selectedModelOptions[control.id]) ??
                  control.defaultValue) === option.value
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
      mobileMenuRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
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
      <div className="fixed inset-0 z-modal bg-black/25" onClick={closeMenu}>
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
                        active ? 'bg-[#1f2933] text-white' : 'bg-surface text-text-secondary',
                      ].join(' ')}
                    >
                      {group.config.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <section
              className="flex min-h-0 flex-1 flex-col space-y-2"
              data-testid="model-selector-submenu"
            >
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
                        aria-disabled={modelDisabled}
                        title={disabledMessage}
                        onClick={() => {
                          if (modelDisabled) {
                            onBlockedModelSelect?.(model, disabledMessage)
                            return
                          }
                          handleSelectModel(model)
                        }}
                        className={[
                          'flex min-h-14 w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left',
                          modelDisabled && 'cursor-not-allowed opacity-70',
                          selected
                            ? 'border-[#b9d1ca] bg-[#e8f2ef]'
                            : 'border-transparent bg-surface',
                        ].join(' ')}
                      >
                        <span className="min-w-0 flex-1">
                          <span
                            className={[
                              'block truncate text-sm font-semibold',
                              modelDisabled ? 'text-text-muted' : 'text-text-primary',
                            ].join(' ')}
                          >
                            {getModelDisplayLabel(model, selectedModelOptions, resolveControlLabel)}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-text-muted">
                            {disabledMessage || model.displayName || model.modelId || model.name}
                          </span>
                        </span>
                        {selected && <Check className="h-5 w-5 shrink-0 text-text-primary" />}
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
      document.body
    )
  }

  function getCompatibilityDisabledMessage(reason?: ModelCompatibilityDisabledReason): string {
    if (reason === 'missing_current_runtime_family') {
      return t(
        'workbench.model_disabled_missing_current_runtime_family',
        'Current model is missing runtime.family'
      )
    }
    if (reason === 'missing_target_runtime_family') {
      return t(
        'workbench.model_disabled_missing_target_runtime_family',
        'This model is missing runtime.family'
      )
    }
    if (reason === 'unavailable') {
      return t('workbench.model_disabled_unavailable', 'This model is unavailable')
    }
    return t(
      'workbench.model_disabled_runtime_family_mismatch',
      'Incompatible with the current model protocol'
    )
  }

  return (
    <div ref={containerRef} className="relative">
      {open && isMobile && renderMobileSheet()}
      {open &&
        !isMobile &&
        createPortal(
          <div
            ref={desktopMenuWrapperRef}
            style={{ left: desktopMenuLeft, top: desktopMenuTop }}
            className={cn('fixed z-system-popover w-64', menuClassName)}
            onMouseLeave={clearDesktopSubmenu}
          >
            <div
              ref={menuPanelRef}
              data-testid="model-selector-menu"
              style={{ maxHeight: desktopMenuMaxHeight }}
              className="w-64 shrink-0 overflow-y-auto rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
            >
              {(desktopControlsAboveFamilies.length > 0 || activeGroup) && (
                <>
                  <div className="mb-1.5 space-y-1.5">
                    {desktopControlsAboveFamilies.map(control => renderControlSection(control))}
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
                      <span className="min-w-0 flex-1 truncate">{getFamilyMenuLabel(group)}</span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
                    </button>
                  )
                })}
              </div>

              {desktopControlsBelowModels.length > 0 && (
                <>
                  <div className="mx-3 my-1.5 border-t border-border" />
                  <div className="space-y-0.5">
                    {desktopControlsBelowModels.map(renderControlMenuItem)}
                  </div>
                </>
              )}
            </div>

            {activeControl ? (
              <div
                ref={submenuPanelRef}
                data-testid="model-selector-submenu"
                style={{ top: submenuOffset, left: submenuLeft, width: submenuWidth }}
                className="absolute max-h-[min(28rem,calc(100vh-8rem))] w-72 overflow-y-auto rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
              >
                {renderControlSection(activeControl, { clearSubmenuOnHover: false })}
              </div>
            ) : activeFamilySubmenuGroup ? (
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
                  {activeFamilySubmenuGroup.models.map(model => {
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
                        aria-disabled={modelDisabled}
                        title={disabledMessage}
                        onClick={() => {
                          if (modelDisabled) {
                            onBlockedModelSelect?.(model, disabledMessage)
                            return
                          }
                          handleSelectModel(model)
                        }}
                        className={[
                          'flex min-h-9 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-[13px] leading-[18px]',
                          modelDisabled
                            ? 'cursor-not-allowed text-text-muted hover:bg-transparent'
                            : 'text-text-primary hover:bg-muted',
                        ].join(' ')}
                      >
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {disabledMessage ? (
                            <>
                              <span className="block truncate">
                                {getModelDisplayLabel(
                                  model,
                                  selectedModelOptions,
                                  resolveControlLabel
                                )}
                              </span>
                              <span className="mt-0.5 block truncate text-xs font-normal text-text-muted">
                                {disabledMessage}
                              </span>
                            </>
                          ) : (
                            getModelDisplayLabel(model, selectedModelOptions, resolveControlLabel)
                          )}
                        </span>
                        {selected && <Check className="h-4 w-4 shrink-0 text-text-secondary" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : activeDesktopSubmenu?.type === 'family' ? (
              <div
                ref={submenuPanelRef}
                data-testid="model-selector-submenu"
                style={{ top: submenuOffset, left: submenuLeft, width: submenuWidth }}
                className="absolute w-72 rounded-2xl border border-border bg-background p-4 text-[13px] leading-[18px] text-text-muted shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
              >
                {t('workbench.no_models')}
              </div>
            ) : null}
          </div>,
          document.body
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
                initialFamilyId ? { type: 'family', id: initialFamilyId } : null
              )
            }
            return nextOpen
          })
        }}
        disabled={disabled}
        className={[
          'flex h-8 min-w-8 items-center gap-1 rounded-full px-2 text-[13px] font-light leading-[18px] text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
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
