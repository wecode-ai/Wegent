import { ArrowLeft, ChevronRight, Sparkles } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

interface MobileSettingsPageProps {
  onBack: () => void
  onOpenPlugins?: () => void
}

export function MobileSettingsPage({
  onBack,
  onOpenPlugins,
}: MobileSettingsPageProps) {
  const { t } = useTranslation('common')

  return (
    <main
      data-testid="mobile-settings-page"
      className="flex h-dvh flex-col overflow-hidden bg-[#d9dadd] px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
    >
      <header className="flex shrink-0 items-center justify-between">
        <button
          type="button"
          data-testid="mobile-settings-back-button"
          onClick={onBack}
          className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-white/55 text-[#30343a] hover:bg-white"
          aria-label={t('workbench.settings_back_to_app', '返回')}
        >
          <ArrowLeft className="h-6 w-6" />
        </button>
        <h1 className="text-lg font-semibold">
          {t('workbench.settings', '设置')}
        </h1>
        <div className="h-11 min-w-[44px]" />
      </header>

      <section className="mt-8 space-y-3">
        <button
          type="button"
          data-testid="mobile-settings-plugins-button"
          onClick={onOpenPlugins}
          className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-white px-4 text-left text-base font-medium text-[#30343a] hover:bg-white/80"
        >
          <Sparkles className="h-5 w-5 shrink-0 text-[#555]" />
          <span className="min-w-0 flex-1 truncate">
            {t('workbench.settings_nav_plugins', '插件')}
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-[#7d838c]" />
        </button>
      </section>
    </main>
  )
}
