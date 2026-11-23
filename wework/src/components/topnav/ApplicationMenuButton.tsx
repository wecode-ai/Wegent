import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Menu } from 'lucide-react'

function openApplicationMenu(): void {
  void invokeDesktopHost('applicationMenu.popup', { windowLabel: getDesktopWindowLabel() }).catch(
    error => console.error('[application-menu] failed to open menu', error)
  )
}

/**
 * Exposes the native application menu on Windows and Linux, where the
 * frameless window hides the OS menu bar. macOS uses the system menu bar
 * instead and does not render this button.
 */
export function ApplicationMenuButton() {
  const { t } = useTranslation('common')
  const label = t('common.application_menu')
  useWindowEvent('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey) return
    if ((event.altKey && event.code === 'KeyF') || (!event.altKey && event.key === 'F10')) {
      event.preventDefault()
      openApplicationMenu()
    }
  })

  return (
    <Tooltip label={label} side="bottom">
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="application-menu-button"
        aria-label={label}
        aria-haspopup="menu"
        onClick={openApplicationMenu}
        className="electron-titlebar-interactive-region mx-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary md:h-7 md:w-7"
      >
        <Menu className="h-4 w-4" />
      </ControlButton>
    </Tooltip>
  )
}
