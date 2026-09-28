import { useState } from 'react'
import { ModelSelector as SharedModelSelector } from '@wegent/collaboration/controls/ModelSelector'
import type { ModelSelectorProps } from '@wegent/collaboration/controls/model-selector-types'
import { useTranslation } from '@/hooks/useTranslation'
import { useConfiguredKeybinding } from '@/hooks/useConfiguredKeybinding'
import { useEmbeddedBrowserOcclusion } from '@/hooks/useEmbeddedBrowserOcclusion'
import { useIsMobile } from '@/hooks/useIsMobile'
import { navigateTo } from '@/lib/navigation'
import { TOGGLE_MODEL_SELECTOR_COMMAND } from '@/lib/keybindings'

function getDesktopViewportRightBoundary(anchor: HTMLElement | null | undefined): number {
  const shell = document.getElementById('right-workspace-panel-shell')
  if (shell && shell.getAttribute('aria-hidden') !== 'true') {
    const rect = shell.getBoundingClientRect()
    if (rect.width > 0 && !anchor?.closest('#right-workspace-panel-shell')) {
      return Math.round(rect.left)
    }
  }
  return window.innerWidth
}

export function ModelSelector(props: ModelSelectorProps) {
  const { t } = useTranslation('common')
  const isMobile = useIsMobile()
  const shortcut = useConfiguredKeybinding(TOGGLE_MODEL_SELECTOR_COMMAND)
  const [flyoutOpen, setFlyoutOpen] = useState(false)
  useEmbeddedBrowserOcclusion('model-selector-flyout', flyoutOpen)
  return (
    <SharedModelSelector
      {...props}
      translate={(key, fallback, options) => t(key, fallback ?? key, options)}
      isMobile={isMobile}
      shortcut={shortcut}
      onOpenModelSettings={() => navigateTo('/settings/personal/models')}
      onOpenCloudConnections={() => navigateTo('/settings/connections')}
      onFlyoutOpenChange={setFlyoutOpen}
      getViewportRightBoundary={getDesktopViewportRightBoundary}
    />
  )
}
