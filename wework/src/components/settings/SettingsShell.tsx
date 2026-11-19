import { DesktopTopBar } from '@/components/layout/DesktopTopBar'
import { useResizableSidebar } from '@/components/layout/useResizableSidebar'
import {
  defaultAppearance,
  getWorkbenchBackground,
  useOptionalAppearance,
} from '@/features/appearance'
import { useIsDesktop } from '@/hooks/useIsDesktop'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Button } from '@wegent/collaboration/markdown/Button'
import { ArrowLeft, ChevronDown, PanelLeft, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'

export function SettingsShell({
  children,
  navigation,
  activeLabel,
  onBack,
}: {
  children: ReactNode
  navigation(close: () => void): ReactNode
  activeLabel: string
  onBack(): void
}) {
  const { t } = useTranslation('common')
  const wide = useIsDesktop(768)
  const [navigationOpen, setNavigationOpen] = useState(false)
  if (wide && navigationOpen) setNavigationOpen(false)
  const appearanceContext = useOptionalAppearance()
  const appearance = appearanceContext?.appearance ?? defaultAppearance
  const background = getWorkbenchBackground(appearance, appearanceContext?.resolvedMode ?? 'light')
  const { sidebarWidth, handleResizeStart } = useResizableSidebar()
  const closeNavigation = () => setNavigationOpen(false)
  const back = (
    <Button
      variant="unstyled"
      type="button"
      data-testid="settings-back-button"
      onClick={onBack}
      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-text-secondary hover:bg-[rgb(var(--color-sidebar-hover))]"
    >
      <ArrowLeft aria-hidden="true" className="h-4 w-4" />
      {t('workbench.settings_back_to_app', '返回')}
    </Button>
  )
  return (
    <div
      data-testid="wework-settings-page"
      className={cn(
        'relative flex h-full min-w-0 flex-1 overflow-hidden text-text-primary max-md:flex-col',
        background.imagePath && (background.inMain || background.inSidebar || background.inTopBar)
          ? 'bg-transparent'
          : 'bg-background'
      )}
    >
      {wide ? (
        <aside
          className={cn(
            'relative flex shrink-0 flex-col border-r border-border/70 px-1.5 pb-4 shadow-[inset_-1px_0_0_rgb(var(--color-border))] max-lg:max-w-[35vw]',
            background.imagePath && background.inSidebar
              ? 'bg-background/25'
              : 'bg-[rgb(var(--color-sidebar))] backdrop-blur-xl backdrop-saturate-150'
          )}
          style={{ width: sidebarWidth }}
        >
          <DesktopTopBar
            testId="settings-sidebar-topbar"
            className="-mx-1.5 mb-1 w-[calc(100%+0.75rem)] shrink-0 bg-transparent pr-2 pl-2"
            left={back}
          />
          {navigation(closeNavigation)}
          <Button
            variant="unstyled"
            type="button"
            data-testid="settings-sidebar-resize-handle"
            onPointerDown={handleResizeStart}
            className="absolute right-[-4px] top-0 z-20 h-full w-3 cursor-col-resize bg-transparent"
            aria-label={t('workbench.resize_sidebar', '调整侧边栏宽度')}
          />
        </aside>
      ) : (
        <header
          data-testid="settings-mobile-toolbar"
          className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-3"
        >
          {back}
          <Button
            variant="ghost"
            type="button"
            data-testid="settings-navigation-open"
            aria-label={t('workbench.settings', '设置') + ': ' + activeLabel}
            aria-haspopup="dialog"
            aria-expanded={navigationOpen}
            onClick={() => setNavigationOpen(true)}
            className="min-w-0 flex-1 justify-start"
          >
            <PanelLeft aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{activeLabel}</span>
            <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0" />
          </Button>
        </header>
      )}
      <main
        data-testid="settings-page-content"
        className={cn(
          'min-h-0 min-w-0 flex-1 overflow-auto px-4 py-6 md:px-8 md:py-8',
          background.imagePath && background.inMain ? 'bg-background/20' : 'bg-background'
        )}
      >
        {children}
      </main>
      {!wide && navigationOpen && (
        <div className="fixed inset-0 z-modal bg-black/20">
          <DialogSurface
            onClose={closeNavigation}
            initialFocus='[data-testid="settings-navigation-close"]'
            finalFocus={() =>
              document.querySelector<HTMLElement>('[data-testid="settings-navigation-open"]') ??
              document.querySelector<HTMLElement>(
                '[data-testid="settings-sidebar-nav"] [aria-current="page"]'
              )
            }
            render={
              <section
                data-testid="settings-navigation-dialog"
                aria-label={t('workbench.settings', '设置')}
                className="absolute inset-y-0 left-0 flex w-[min(20rem,calc(100vw-3rem))] flex-col bg-background px-1.5 pb-4 text-text-primary shadow-xl"
              />
            }
          >
            <header className="flex min-h-14 shrink-0 items-center justify-between gap-2 px-3">
              <span className="font-medium">{t('workbench.settings', '设置')}</span>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                data-testid="settings-navigation-close"
                aria-label={t('common.close', '关闭')}
                onClick={closeNavigation}
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </Button>
            </header>
            {navigation(closeNavigation)}
          </DialogSurface>
        </div>
      )}
    </div>
  )
}
