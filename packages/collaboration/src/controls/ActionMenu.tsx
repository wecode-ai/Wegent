import {
  controlIconActionDensity,
  controlMenuTriggerDensity,
  controlOption,
  controlPopup,
  type ControlDensity,
} from './recipes'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from './MenuParts'
import { Check, ChevronRight, MoreHorizontal } from 'lucide-react'
import { useRef, useState, type ComponentType, type ReactNode } from 'react'
import { Tooltip } from './Tooltip'
import { KeyboardShortcut } from './KeyboardShortcut'
import { useFocusRequest } from '../dom-events'
import { useCollaborationPortalTheme } from '../theme'

interface ActionMenuEntry {
  label: ReactNode
  description?: ReactNode
  icon?: ComponentType<{ className?: string }>
  onSelect?: () => void | Promise<void>
  testId?: string
  id?: string
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  shortcut?: string
  children?: ActionMenuItem[]
  /** Renders a static separator row instead of an interactive item. */
  separator?: boolean
  /** Renders a custom non-button row (e.g. inline zoom controls). */
  custom?: ReactNode
}

export type ActionMenuItem = ActionMenuEntry &
  ({ testId: string; id?: string } | { id: string; testId?: string })

interface ActionMenuProps {
  ariaLabel: string
  testId?: string
  menuTestId?: string
  items: ActionMenuItem[]
  icon?: ComponentType<{ className?: string }>
  triggerLabel?: ReactNode
  disabled?: boolean
  variant?: 'horizontal' | 'vertical'
  density?: ControlDensity
  triggerClassName?: string
  placement?: 'side' | 'bottom-end' | 'top-start' | 'bottom-start' | 'top-end'
  contextMenuPosition?: MenuPosition | null
  width?: number
  itemClassName?: string
  submenuCloseDelayMs?: number
  onContextMenuClose?: () => void
  onOpenChange?: (open: boolean) => void
  portalContainer?: Element | null
  open?: boolean
  hideTrigger?: boolean
  anchor?: HTMLElement | null
  showTriggerTooltip?: boolean
}

export interface MenuPosition {
  left: number
  top: number
}

const itemStyle = controlOption
const contentStyle = controlPopup + ' min-w-44'

function MenuEntries({
  items,
  itemClassName,
  submenuCloseDelayMs,
}: {
  items: ActionMenuItem[]
  itemClassName?: string
  submenuCloseDelayMs: number
}) {
  const theme = useCollaborationPortalTheme()
  return items.map(item => {
    const key = item.id ?? item.testId!
    if (item.separator)
      return (
        <MenuSeparator
          key={key}
          data-testid={item.testId}
          className="my-1 border-t border-border"
        />
      )
    if (item.custom)
      return (
        <div key={key} data-testid={item.testId}>
          {item.custom}
        </div>
      )
    const Icon = item.icon
    const label = (
      <>
        {Icon && <Icon className="h-4 w-4 shrink-0" />}
        <span className="min-w-0 flex-1">
          <span className="block">{item.label}</span>
          {item.description && (
            <span className="block whitespace-normal text-xs text-text-secondary">
              {item.description}
            </span>
          )}
        </span>
        {item.checked && <Check className="h-4 w-4" />}
        {item.shortcut && (
          <MenuShortcut className="ml-auto text-text-secondary">
            <KeyboardShortcut value={item.shortcut} className="bg-transparent px-0 text-xs" />
          </MenuShortcut>
        )}
      </>
    )
    const className = [itemStyle, itemClassName, item.danger ? 'text-destructive' : '']
      .filter(Boolean)
      .join(' ')
    if (item.children?.length)
      return (
        <MenuSub key={key} delay={submenuCloseDelayMs}>
          <MenuSubTrigger data-testid={item.testId} disabled={item.disabled} className={className}>
            {label}
            <ChevronRight className="h-4 w-4" />
          </MenuSubTrigger>
          <MenuSubContent
            {...theme}
            data-testid={item.testId ? item.testId + '-submenu' : undefined}
            className={theme.className + ' ' + contentStyle}
            side="right"
            sideOffset={4}
            collisionPadding={8}
          >
            <MenuEntries
              items={item.children}
              itemClassName={itemClassName}
              submenuCloseDelayMs={submenuCloseDelayMs}
            />
          </MenuSubContent>
        </MenuSub>
      )
    return (
      <MenuItem
        key={key}
        data-testid={item.testId}
        value={key}
        disabled={item.disabled}
        aria-current={item.checked || undefined}
        destructive={item.danger}
        shortcut={item.shortcut}
        onSelect={item.onSelect}
        className={className}
      >
        {state => (
          <>
            {label}
            {state.error ? (
              <span role="alert" className="whitespace-normal text-xs text-destructive">
                {state.error instanceof Error
                  ? state.error.message
                  : typeof state.error === 'string'
                    ? state.error
                    : null}
              </span>
            ) : null}
          </>
        )}
      </MenuItem>
    )
  })
}

export function ActionMenu({
  ariaLabel,
  testId,
  menuTestId,
  items,
  icon: Icon = MoreHorizontal,
  triggerLabel,
  disabled = false,
  variant = 'horizontal',
  density = 'compact',
  triggerClassName,
  placement = 'side',
  contextMenuPosition,
  width,
  itemClassName,
  submenuCloseDelayMs = 100,
  onContextMenuClose,
  onOpenChange,
  portalContainer,
  open: controlledOpen,
  hideTrigger = false,
  anchor,
  showTriggerTooltip = true,
}: ActionMenuProps) {
  const theme = useCollaborationPortalTheme()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useFocusRequest(menuRef, undefined, {
    enabled: Boolean(contextMenuPosition),
    preventScroll: true,
    restoreFocus: true,
  })
  const trigger = (
    <MenuTrigger
      data-testid={testId}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={event => event.stopPropagation()}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-2 text-text-secondary hover:bg-muted',
        triggerClassName,
        'outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 disabled:cursor-not-allowed disabled:opacity-40',
        triggerLabel ? controlMenuTriggerDensity[density] : controlIconActionDensity[density]
      )}
    >
      {triggerLabel ?? (
        <Icon className={variant === 'vertical' ? 'h-4 w-4 rotate-90' : 'h-4 w-4'} />
      )}
    </MenuTrigger>
  )
  return (
    <Menu
      open={(controlledOpen ?? open) || Boolean(contextMenuPosition)}
      container={portalContainer}
      itemShortcuts={false}
      onOpenChange={(next, details) => {
        if (
          !next &&
          hideTrigger &&
          anchor &&
          details.reason === 'outside-press' &&
          details.event?.target instanceof Node &&
          anchor.contains(details.event.target)
        ) {
          details.cancel()
          return
        }
        setOpen(next)
        onOpenChange?.(next)
        if (!next) onContextMenuClose?.()
      }}
    >
      {!hideTrigger &&
        (showTriggerTooltip && !triggerLabel && !disabled ? (
          <Tooltip label={ariaLabel} testId={testId ? `${testId}-tooltip` : undefined}>
            {trigger}
          </Tooltip>
        ) : (
          trigger
        ))}
      <MenuContent
        {...theme}
        ref={menuRef}
        data-testid={menuTestId ?? (testId ? testId + '-menu' : undefined)}
        data-embedded-browser-occlusion
        side={placement === 'side' ? 'right' : placement.startsWith('top') ? 'top' : 'bottom'}
        align={placement.endsWith('start') ? 'start' : 'end'}
        sideOffset={8}
        collisionPadding={8}
        anchor={
          anchor ??
          (contextMenuPosition
            ? { x: contextMenuPosition.left, y: contextMenuPosition.top }
            : undefined)
        }
        finalFocus={hideTrigger && anchor ? () => anchor : undefined}
        style={{ ...theme.style, width }}
        className={theme.className + ' ' + contentStyle}
      >
        <MenuEntries
          items={items}
          itemClassName={itemClassName}
          submenuCloseDelayMs={submenuCloseDelayMs}
        />
      </MenuContent>
    </Menu>
  )
}
