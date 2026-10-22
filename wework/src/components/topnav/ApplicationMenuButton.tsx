import { useEffect } from 'react'
import { Menu } from 'lucide-react'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { useTranslation } from '@/hooks/useTranslation'
import { Tooltip } from '@/components/ui/tooltip'

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
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey) return
      if ((event.altKey && event.code === 'KeyF') || (!event.altKey && event.key === 'F10')) {
        event.preventDefault()
        openApplicationMenu()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        data-testid="application-menu-button"
        aria-label={label}
        aria-haspopup="menu"
        onClick={openApplicationMenu}
        className="electron-titlebar-interactive-region mx-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
      >
        <Menu className="h-4 w-4" />
      </button>
    </Tooltip>
  )
}
