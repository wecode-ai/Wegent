import { useTranslation } from '@/hooks/useTranslation'
import { fileManagerAppLabel, terminalAppLabel } from '@/lib/file-manager'
import {
  prioritizeWorkspaceOpener,
  visibleOpenersForPlatform,
  type LocalWorkspaceOpenerDef,
  type LocalWorkspaceOpenerId,
} from '@/lib/local-workspace-openers'
import { getPlatform } from '@/lib/platform'
import { cn } from '@/lib/utils'
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from '@wegent/collaboration/controls/MenuParts'
import { controlOption, controlPopup } from '@wegent/collaboration/controls/recipes'
import { useCollaborationPortalTheme } from '@wegent/collaboration/theme'
import type { TFunction } from 'i18next'
import { ChevronDown, Code2, Folder, Monitor, Plus, SquareTerminal } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'

interface LocalWorkspaceOpenerPickerProps {
  ariaLabel: string
  buttonTestId?: string
  menuTestId?: string
  optionTestIdPrefix?: string
  disabled?: boolean
  buttonClassName: string
  preferredPlacement?: 'above' | 'below'
  align?: 'start' | 'end'
  availability: Record<LocalWorkspaceOpenerId, boolean | undefined>
  preferredOpener: LocalWorkspaceOpenerId | null
  labels?: Record<string, string | undefined>
  onChooseOther?: () => void | Promise<void>
  onOpen?: () => void | Promise<void>
  onSelect: (opener: LocalWorkspaceOpenerId) => void | Promise<void>
}

export function LocalWorkspaceOpenerPicker({
  ariaLabel,
  buttonTestId,
  menuTestId,
  optionTestIdPrefix,
  disabled = false,
  buttonClassName,
  preferredPlacement = 'below',
  align = 'end',
  availability,
  preferredOpener,
  labels,
  onChooseOther,
  onOpen,
  onSelect,
}: LocalWorkspaceOpenerPickerProps) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  const theme = useCollaborationPortalTheme()

  const prepareMenu = async () => {
    const revision = ++request.current
    setPreparing(true)
    setError(null)
    try {
      await onOpen?.()
      if (request.current === revision) setOpen(true)
    } catch (cause) {
      if (request.current === revision)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request.current === revision) setPreparing(false)
    }
  }

  const platform = getPlatform()
  const openers = prioritizeWorkspaceOpener(visibleOpenersForPlatform(platform), preferredOpener)
  const showChooseOther = platform === 'win' && onChooseOther != null

  return (
    <>
      <Menu
        open={open}
        onOpenChange={(next, details) => {
          if (next && onOpen) {
            details.cancel()
            if (!preparing) void prepareMenu()
          } else {
            setOpen(next)
          }
        }}
      >
        <MenuTrigger
          render={<button type="button" />}
          data-testid={buttonTestId}
          disabled={disabled || preparing}
          aria-busy={preparing || undefined}
          aria-label={ariaLabel}
          className={buttonClassName}
          onClick={event => event.stopPropagation()}
        >
          <ChevronDown className="h-4 w-4" />
        </MenuTrigger>
        <MenuContent
          {...theme}
          data-testid={menuTestId}
          aria-label={ariaLabel}
          side={preferredPlacement === 'above' ? 'top' : 'bottom'}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          className={cn(controlPopup, 'w-70')}
        >
          {openers
            .filter(opener => availability[opener.id] === true)
            .map(opener => (
              <MenuItem
                key={opener.id}
                value={opener.id}
                render={<button type="button" />}
                data-testid={optionTestIdPrefix ? optionTestIdPrefix + '-' + opener.id : undefined}
                onSelect={() => {
                  setOpen(false)
                  return onSelect(opener.id)
                }}
                className={controlOption}
              >
                <LocalWorkspaceOpenerIcon opener={opener.id} className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {openerDisplayLabel(opener, t, labels)}
                </span>
              </MenuItem>
            ))}
          {showChooseOther && (
            <>
              <MenuSeparator className="my-1 h-px bg-border" />
              <MenuItem
                value="choose-other"
                render={<button type="button" />}
                data-testid="open-local-workspace-choose-other-button"
                onSelect={onChooseOther}
                className={controlOption}
              >
                <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t('workbench.opener_choose_other')}
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>
      {error && (
        <span
          role="alert"
          data-testid={buttonTestId ? buttonTestId + '-error' : undefined}
          className="text-sm text-destructive"
        >
          {ariaLabel}: {error}
        </span>
      )}
    </>
  )
}

function openerDisplayLabel(
  opener: LocalWorkspaceOpenerDef,
  t: TFunction,
  labels?: Record<string, string | undefined>
): string {
  if (opener.id === 'file-manager') return fileManagerAppLabel(t)
  if (opener.id === 'terminal') return terminalAppLabel(t)
  return labels?.[opener.id] ?? opener.label
}

export function LocalWorkspaceOpenerIcon({
  opener,
  className,
}: {
  opener: LocalWorkspaceOpenerId
  className?: string
}) {
  const wrapperClassName = cn(
    'inline-flex items-center justify-center overflow-hidden rounded-md border border-border/50 shadow-sm wework:border-black/5',
    className
  )

  if (opener === 'vscode' || opener === 'vscode-insiders') {
    const color = opener === 'vscode' ? '#1f7fbf' : '#4aa99d'
    return (
      <span className={cn(wrapperClassName, 'bg-background')} aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" className="h-full w-full" aria-hidden="true">
          <path
            data-testid="local-workspace-vscode-mark"
            d="M18.5 2.5 10.8 9.9 5.4 5.7 2 7.4v9.2l3.4 1.7 5.4-4.2 7.7 7.4 3.5-1.8V4.3l-3.5-1.8ZM5.4 15.7V8.3l4.2 3.7-4.2 3.7Zm12.9 2.1-6.5-5.8 6.5-5.8v11.6Z"
            fill={color}
            fillRule="evenodd"
          />
        </svg>
      </span>
    )
  }

  return (
    <span className={cn(wrapperClassName, openerIconBackground(opener))} aria-hidden="true">
      {openerIconContent(opener)}
    </span>
  )
}

function openerIconBackground(opener: LocalWorkspaceOpenerId): string {
  switch (opener) {
    case 'cursor':
      return 'bg-[#505050] text-white'
    case 'sublime-text':
      return 'bg-[#5b5f64] text-[#ffb64a]'
    case 'windsurf':
      return 'bg-[#f7f7f4] text-[#4d4d4d]'
    case 'file-manager':
      return 'bg-[#5aa9ff] text-white'
    case 'terminal':
    case 'cmd':
    case 'powershell':
      return 'bg-[#525252] text-white'
    case 'iterm2':
      return 'bg-[#3a3541] text-[#67e887]'
    case 'ghostty':
      return 'bg-[#5969a6] text-white'
    case 'warp':
      return 'bg-[#e6e8eb] text-[#4f5357]'
    case 'xcode':
      return 'bg-[#49b9f2] text-white'
    case 'android-studio':
      return 'bg-white text-[#3f82f8]'
    case 'intellij-idea':
      return 'bg-gradient-to-br from-[#ff6b3d] via-[#d642e9] to-[#2f7df6] text-white'
    default:
      return 'bg-[#f2f7fb] text-[#007ACC]'
  }
}

function openerIconContent(opener: LocalWorkspaceOpenerId): ReactNode {
  switch (opener) {
    case 'file-manager':
      return <Folder className="h-3.5 w-3.5" />
    case 'terminal':
    case 'cmd':
    case 'powershell':
    case 'iterm2':
    case 'ghostty':
    case 'warp':
      return <SquareTerminal className="h-3.5 w-3.5" />
    case 'xcode':
    case 'android-studio':
    case 'intellij-idea':
      return <Monitor className="h-3.5 w-3.5" />
    case 'cursor':
    case 'sublime-text':
    case 'windsurf':
      return <Code2 className="h-3.5 w-3.5" />
    default:
      return <Code2 className="h-3.5 w-3.5" />
  }
}
