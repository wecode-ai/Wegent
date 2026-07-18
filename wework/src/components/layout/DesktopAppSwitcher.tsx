import { ChevronDown, Settings } from 'lucide-react'
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { useTranslation } from '@/hooks/useTranslation'
import { dispatchOpenSettingsShortcut } from '@/lib/keybindings'
import { cn } from '@/lib/utils'

export type DesktopAppKey = 'wework' | 'todo' | 'apps' | 'wegent'

interface DesktopAppSwitcherProps {
  activeApp: DesktopAppKey
  onNavigate: (app: DesktopAppKey) => void
  className?: string
  testIds?: Partial<Record<DesktopAppKey, string>>
}

interface AppOption {
  key: DesktopAppKey
  suffix: string
  label: string
  description: string
  availabilityLabel?: string
  disabled?: boolean
}

interface MenuPosition {
  left: number
  top: number
  originY: number
}

interface RollingSuffix {
  from: string
  to: string
  direction: 'up' | 'down'
}

const MENU_WIDTH = 184
const MENU_ROW_STEP = 42
const MENU_VIEWPORT_PADDING = 8
const MENU_TRANSITION_MS = 160
const SUFFIX_TRANSITION_MS = 260

function Suffix({ value }: { value: string }) {
  return (
    <>
      <span className="text-[#3978c5]">{value[0]}</span>
      {value.slice(1)}
    </>
  )
}

export function DesktopAppSwitcher({
  activeApp,
  onNavigate,
  className,
  testIds,
}: DesktopAppSwitcherProps) {
  const { t } = useTranslation('common')
  const cloudConnection = useContext(CloudConnectionContext)
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | null>(null)
  const blurTimerRef = useRef<number | null>(null)
  const [menuMounted, setMenuMounted] = useState(false)
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const [displayedKey, setDisplayedKey] = useState<DesktopAppKey>(activeApp)
  const [rollingSuffix, setRollingSuffix] = useState<RollingSuffix | null>(null)
  const [menuBlurred, setMenuBlurred] = useState(false)

  const options = useMemo<AppOption[]>(
    () => [
      {
        key: 'wegent',
        suffix: 'gent',
        label: 'Wegent',
        description: t('workbench.app_wegent_description', '云端智能体平台'),
        availabilityLabel: cloudConnection?.isConnected
          ? undefined
          : t('workbench.app_wegent_requires_cloud', '连接云端后可用'),
        disabled: !cloudConnection?.isConnected && activeApp !== 'wegent',
      },
      {
        key: 'wework',
        suffix: 'work',
        label: 'Wework',
        description: t('workbench.app_wework_description', '对话与本地工作台'),
      },
      ...(experimentalFeaturesEnabled || activeApp === 'todo'
        ? [
            {
              key: 'todo' as const,
              suffix: 'loop',
              label: 'Weloop',
              description: t('workbench.app_weloop_description', '智能体工作流面板'),
            },
          ]
        : []),
    ],
    [activeApp, cloudConnection?.isConnected, experimentalFeaturesEnabled, t]
  )
  const displayedAppKey = rollingSuffix ? displayedKey : activeApp
  const selected =
    options.find(option => option.key === displayedAppKey) ??
    options.find(option => option.key === 'wework') ??
    options[0]
  const selectedIndex = options.findIndex(option => option.key === selected.key)
  const menuOptions = [selected, ...options.filter(option => option.key !== selected.key)]
  const triggerTestId = testIds?.[selected.key] ?? `chrome-tab-${selected.key}`

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const clearBlurTimer = useCallback(() => {
    if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current)
    blurTimerRef.current = null
  }, [])

  useEffect(
    () => () => {
      clearTimer()
      clearBlurTimer()
    },
    [clearBlurTimer, clearTimer]
  )

  const closeMenu = useCallback(() => {
    setOpen(false)
    setMenuBlurred(false)
    clearBlurTimer()
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      setMenuMounted(false)
      setMenuPosition(null)
    }, MENU_TRANSITION_MS)
  }, [clearBlurTimer, clearTimer])

  const openMenu = () => {
    clearTimer()
    clearBlurTimer()
    setMenuBlurred(false)
    setMenuMounted(true)
    window.requestAnimationFrame(() => {
      setOpen(true)
      blurTimerRef.current = window.setTimeout(() => {
        setMenuBlurred(true)
        blurTimerRef.current = null
      }, MENU_TRANSITION_MS)
    })
  }

  useLayoutEffect(() => {
    if (!menuMounted) return

    const updatePosition = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const menuHeight = options.length * MENU_ROW_STEP + 8
      const desiredTop = rect.top - 5
      const maxTop = Math.max(
        MENU_VIEWPORT_PADDING,
        window.innerHeight - menuHeight - MENU_VIEWPORT_PADDING
      )
      const top = Math.max(MENU_VIEWPORT_PADDING, Math.min(desiredTop, maxTop))
      const left = Math.max(
        MENU_VIEWPORT_PADDING,
        Math.min(rect.left, window.innerWidth - MENU_WIDTH - MENU_VIEWPORT_PADDING)
      )
      setMenuPosition({ left, top, originY: rect.top - top + rect.height / 2 })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [menuMounted, options.length])

  useEffect(() => {
    if (!menuMounted) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeMenu, menuMounted])

  const selectApp = (option: AppOption) => {
    if (option.disabled) return
    if (option.key === selected.key) {
      closeMenu()
      return
    }

    const nextIndex = options.findIndex(item => item.key === option.key)
    setRollingSuffix({
      from: selected.suffix,
      to: option.suffix,
      direction: nextIndex > selectedIndex ? 'up' : 'down',
    })
    setDisplayedKey(option.key)
    closeMenu()
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      setRollingSuffix(null)
      setMenuMounted(false)
      setMenuPosition(null)
      onNavigate(option.key)
    }, SUFFIX_TRANSITION_MS)
  }

  return (
    <nav
      data-testid="desktop-app-switcher"
      aria-label={t('workbench.app_navigation', '应用导航')}
      className={cn(
        'relative ml-1 flex shrink-0 items-center pl-2 before:absolute before:left-0 before:h-4 before:w-px before:bg-border',
        className
      )}
    >
      <span className="select-none pl-1 text-sm font-semibold leading-none text-text-primary">
        We
      </span>
      <button
        ref={triggerRef}
        type="button"
        data-testid={triggerTestId}
        onClick={() => (open ? closeMenu() : void openMenu())}
        className={cn(
          'ml-px flex h-8 items-center rounded-lg py-0 pl-0 pr-2 text-sm font-semibold leading-none text-text-primary transition-[color,transform] duration-150 hover:text-text-secondary',
          open && 'pointer-events-none'
        )}
        aria-label={`${selected.label}，${t('workbench.app_navigation', '应用导航')}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="relative inline-block h-[1em] w-[2.4em] overflow-hidden align-middle leading-none">
          {rollingSuffix ? (
            <>
              <span
                className={cn(
                  'absolute inset-y-0 left-0',
                  rollingSuffix.direction === 'up' ? 'suffix-roll-out-up' : 'suffix-roll-out-down'
                )}
              >
                <Suffix value={rollingSuffix.from} />
              </span>
              <span
                className={cn(
                  'absolute inset-y-0 left-0',
                  rollingSuffix.direction === 'up' ? 'suffix-roll-in-up' : 'suffix-roll-in-down'
                )}
              >
                <Suffix value={rollingSuffix.to} />
              </span>
            </>
          ) : (
            <Suffix value={selected.suffix} />
          )}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'h-3 w-3 text-text-muted transition-[margin,transform]',
            open ? 'ml-6 rotate-180' : 'ml-1'
          )}
        />
      </button>
      {menuMounted &&
        createPortal(
          <>
            <div
              aria-hidden="true"
              className={cn(
                'pointer-events-none fixed z-system-popover translate-z-0 bg-white/[0.01] transition-opacity duration-100',
                menuBlurred ? 'opacity-100' : 'opacity-0'
              )}
              style={{
                left: menuPosition?.left ?? 0,
                top: (menuPosition?.top ?? 0) + 20,
                width: MENU_WIDTH,
                height: Math.max(0, menuOptions.length * MENU_ROW_STEP + 8 - 20),
                visibility: menuPosition ? 'visible' : 'hidden',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
              }}
            />
            <div
              ref={menuRef}
              role="menu"
              data-testid="desktop-app-switcher-menu"
              style={{
                left: menuPosition?.left ?? 0,
                top: menuPosition?.top ?? 0,
                width: MENU_WIDTH,
                transformOrigin: `50% ${menuPosition?.originY ?? 16}px`,
                visibility: menuPosition ? 'visible' : 'hidden',
              }}
              className={cn(
                'fixed z-system-popover isolate flex origin-top flex-col gap-0.5 overflow-hidden text-text-primary transition-[clip-path,opacity,transform] duration-200 ease-out',
                open
                  ? 'translate-y-0 opacity-100 [clip-path:inset(0_0_0_0_round_0.75rem)]'
                  : 'pointer-events-none -translate-y-1 opacity-0 [clip-path:inset(0_0_100%_0_round_0.75rem)]'
              )}
            >
              {menuOptions.map((option, index) => {
                const active = option.key === selected.key
                return (
                  <div
                    key={option.key}
                    className={cn(
                      'relative z-10 flex min-h-10 w-full items-center rounded-lg py-1 pl-0 pr-2 text-left transition-[background-color,opacity,transform] duration-200 ease-out',
                      active ? 'bg-transparent' : 'hover:bg-black/[0.035]',
                      open ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0'
                    )}
                    style={{ transitionDelay: open ? `${index * 28}ms` : '0ms' }}
                  >
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      aria-disabled={option.disabled || undefined}
                      disabled={option.disabled}
                      data-testid={`app-switcher-option-${option.key}`}
                      onClick={() => selectApp(option)}
                      className={cn(
                        'relative z-10 grid min-w-0 flex-1 gap-0.5 text-left',
                        option.disabled && 'cursor-not-allowed opacity-60'
                      )}
                    >
                      <span
                        className={cn(
                          'origin-left text-sm font-medium leading-4 transition-transform duration-200 ease-out',
                          active && 'invisible -translate-y-px'
                        )}
                      >
                        <Suffix value={option.suffix} />
                        {option.availabilityLabel ? (
                          <span className="ml-2 text-xs font-normal text-text-muted">
                            {option.availabilityLabel}
                          </span>
                        ) : null}
                      </span>
                      <span className="whitespace-nowrap text-xs leading-4 text-text-muted">
                        {option.description}
                      </span>
                    </button>
                    {active ? (
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="app-switcher-settings"
                        aria-label={t('workbench.settings', '设置')}
                        onClick={() => {
                          closeMenu()
                          dispatchOpenSettingsShortcut()
                        }}
                        className="absolute left-[calc(2.4em-0.25rem)] top-0 z-10 rounded-md p-1 text-text-muted transition-colors hover:bg-black/[0.06] hover:text-text-primary"
                      >
                        <Settings aria-hidden="true" className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </>,
          document.body
        )}
    </nav>
  )
}
