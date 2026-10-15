import { useEffect } from 'react'
import { keybindingFromKeyboardEvent, shouldIgnoreWorkbenchShortcut } from '@/lib/keybindings'
import { getPlatform } from '@/lib/platform'

interface RightWorkspaceShortcutOptions {
  active: boolean
  canOpenReview: boolean
  allowTemporaryChat: boolean
  canBrowseFiles: boolean
  onNavigate: (action: () => void) => void
  onSelectReview: () => void
  onSelectBrowser: () => void
  onSelectChat: () => void
  onSelectFiles: () => void
}

export function useRightWorkspaceShortcuts({
  active,
  canOpenReview,
  allowTemporaryChat,
  canBrowseFiles,
  onNavigate,
  onSelectReview,
  onSelectBrowser,
  onSelectChat,
  onSelectFiles,
}: RightWorkspaceShortcutOptions) {
  const primary = getPlatform() === 'mac' ? 'Command' : 'Control'

  useEffect(() => {
    if (!active) return

    const altPrimary = primary === 'Control' ? 'Control+Alt' : 'Alt+Command'
    const actions: Record<string, (() => void) | false> = {
      [`${primary}+T`]: onSelectBrowser,
      [`${altPrimary}+R`]: canOpenReview && onSelectReview,
      [`${altPrimary}+S`]: allowTemporaryChat && onSelectChat,
      [`${altPrimary}+F`]: canBrowseFiles && onSelectFiles,
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const action = actions[keybindingFromKeyboardEvent(event)]
      if (!action) return
      const target = event.target
      const workbench =
        target instanceof HTMLElement ? target.closest('[data-active-workbench-pane]') : null
      if (
        (target instanceof HTMLElement &&
          target.closest('[role="dialog"], [role="alertdialog"]')) ||
        (workbench && workbench.getAttribute('data-active-workbench-pane') !== 'true')
      ) {
        return
      }
      if (shouldIgnoreWorkbenchShortcut(event) && !workbench) return
      event.preventDefault()
      event.stopPropagation()
      onNavigate(action)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [
    active,
    allowTemporaryChat,
    canBrowseFiles,
    canOpenReview,
    onNavigate,
    onSelectBrowser,
    onSelectChat,
    onSelectFiles,
    onSelectReview,
    primary,
  ])
}
