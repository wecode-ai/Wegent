import {
  Archive,
  ArrowLeft,
  ChevronRight,
  Globe2,
  Info,
  MessageSquareText,
  Package,
  Palette,
  Plug,
  SlidersHorizontal,
  Server,
  Terminal,
  UserRound,
} from 'lucide-react'
import { useState } from 'react'
import { AppearanceSettingsPage } from '@/features/appearance/AppearanceSettingsPage'
import { DshSettingsSurface } from '@/features/dsh-runtime/DshSettingsSurface'
import type { WeworkDshSettingsPage } from '@/features/dsh-runtime/dshSettings'
import { resolveDshSettingsIcon } from '@/features/dsh-runtime/dshSettingsIcons'
import { ExperimentalBadge } from '@/features/experimental-features/ExperimentalBadge'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import { SHOW_PLUGINS_NAVIGATION } from '@/features/plugins/visibility'
import { useTranslation } from '@/hooks/useTranslation'
import { GeneralSettingsPage } from './GeneralSettingsPage'
import { ContextSettingsPage } from './ContextSettingsPage'
import { ModelSettingsPage } from './ModelSettingsPage'
import { PluginSettingsPage } from './PluginSettingsPage'
import { ArchivedConversationsSettingsPage } from './ArchivedConversationsSettingsPage'
import { AboutSettingsPage } from './AboutSettingsPage'
import { QuickPhrasesSettingsPage } from './QuickPhrasesSettingsPage'
import { RuntimeSettingsPage } from './RuntimeSettingsPage'
import { HarnessSettingsPage } from './HarnessSettingsPage'
import { ConnectionsDeviceSettingsPage } from './ConnectionsSettingsPage'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RefreshWorkLists } from '@/features/workbench/workbenchContextTypes'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'

interface MobileSettingsPageProps {
  onBack: () => void
  onOpenPlugins?: () => void
  services?: WorkbenchServices
  devices?: DeviceInfo[]
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void>
  onRefreshWorkLists?: RefreshWorkLists
}

const MOBILE_BUILTIN_SETTINGS = new Set([
  'about',
  'appearance',
  'connections',
  'context',
  'general',
  'harnesses',
  'models',
  'plugins',
  'quick-phrases',
  'runtimes',
])

export function MobileSettingsPage({
  onBack,
  onOpenPlugins,
  services,
  devices = [],
  onOpenRuntimeTask,
  onRefreshWorkLists,
}: MobileSettingsPageProps) {
  const { t } = useTranslation('common')
  const settingsContributions = useDshSlotEntries<WeworkDshSettingsPage>(
    WEWORK_DSH_SLOTS.settingsPage
  )
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  const extensionSettingsPages = settingsContributions.filter(
    page =>
      !MOBILE_BUILTIN_SETTINGS.has(page.id) &&
      (!page.experimental || experimentalFeaturesEnabled) &&
      !page.desktopOnly
  )
  const [activePage, setActivePage] = useState('menu')
  const activeExtensionPage = extensionSettingsPages.find(page => page.id === activePage)

  if (activeExtensionPage) {
    return (
      <main
        data-testid={`mobile-${activeExtensionPage.id}-settings-page`}
        className="flex h-dvh flex-col overflow-hidden bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
      >
        <header className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            data-testid={`mobile-${activeExtensionPage.id}-settings-back-button`}
            onClick={() => setActivePage('menu')}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
            aria-label={t('workbench.settings_back_to_app')}
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold">
            {t(
              `workbench.${activeExtensionPage.labelKey ?? activeExtensionPage.id}`,
              activeExtensionPage.label
            )}
          </h1>
          <div className="h-11 min-w-[44px]" />
        </header>
        <div className="mt-6 min-h-0 flex-1 overflow-auto">
          <DshSettingsSurface
            page={activeExtensionPage}
            services={services}
            devices={devices}
            onBack={() => setActivePage('menu')}
            onOpenCloudSettings={() => setActivePage('connections')}
            onOpenRuntimeTask={onOpenRuntimeTask}
            onRefreshWorkLists={onRefreshWorkLists}
          />
        </div>
      </main>
    )
  }

  if (activePage === 'connections') {
    return (
      <main
        data-testid="mobile-connections-settings-page"
        className="flex h-dvh flex-col overflow-hidden bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
      >
        <header className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            data-testid="mobile-connections-settings-back-button"
            onClick={() => setActivePage('menu')}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
            aria-label={t('workbench.settings_back_to_app')}
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold">
            {t('workbench.settings_nav_connections', '云端连接')}
          </h1>
          <div className="h-11 min-w-[44px]" />
        </header>
        <div className="mt-6 min-h-0 flex-1 overflow-auto">
          <ConnectionsDeviceSettingsPage showHeader={false} />
        </div>
      </main>
    )
  }

  if (activePage === 'quick-phrases') {
    return (
      <main
        data-testid="mobile-quick-phrases-settings-page"
        className="flex h-dvh flex-col overflow-hidden bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
      >
        <header className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            data-testid="mobile-quick-phrases-back-button"
            onClick={() => setActivePage('personal')}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
            aria-label={t('workbench.settings_back_to_app', '返回')}
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold">{t('workbench.quick_phrases', '快捷短语')}</h1>
          <div className="h-11 min-w-[44px]" />
        </header>
        <div className="mt-6 min-h-0 flex-1 overflow-auto">
          <QuickPhrasesSettingsPage />
        </div>
      </main>
    )
  }

  if (activePage === 'runtimes') {
    return (
      <main
        data-testid="mobile-runtime-settings-page"
        className="flex h-dvh flex-col overflow-hidden bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
      >
        <header className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            data-testid="mobile-runtime-settings-back-button"
            onClick={() => setActivePage('personal')}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
            aria-label={t('workbench.settings_back_to_app', '返回')}
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold">
            {t('workbench.settings_nav_runtimes', 'Runtime')}
          </h1>
          <div className="h-11 min-w-[44px]" />
        </header>
        <div className="mt-6 min-h-0 flex-1 overflow-auto">
          <RuntimeSettingsPage
            runtimeProfileApi={services?.runtimeProfileApi}
            deliveryApi={services?.deliveryApi}
            deviceApi={services?.deviceApi}
            modelApi={services?.modelApi}
          />
        </div>
      </main>
    )
  }

  if (activePage === 'general') {
    return (
      <main
        data-testid="mobile-general-settings-page"
        className="flex h-dvh flex-col overflow-hidden bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
      >
        <header className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            data-testid="mobile-general-back-button"
            onClick={() => setActivePage('personal')}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
            aria-label={t('workbench.settings_back_to_app', '返回')}
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold">{t('workbench.settings_nav_general')}</h1>
          <div className="h-11 min-w-[44px]" />
        </header>
        <div className="mt-6 min-h-0 flex-1 overflow-auto">
          <GeneralSettingsPage />
        </div>
      </main>
    )
  }

  if (activePage === 'appearance') {
    return (
      <main
        data-testid="mobile-appearance-settings-page"
        className="flex h-dvh flex-col overflow-hidden bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
      >
        <header className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            data-testid="mobile-appearance-back-button"
            onClick={() => setActivePage('personal')}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
            aria-label={t('workbench.settings_back_to_app', '返回')}
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold">{t('workbench.appearance_title', '外观')}</h1>
          <div className="h-11 min-w-[44px]" />
        </header>
        <div className="mt-6 min-h-0 flex-1 overflow-auto">
          <AppearanceSettingsPage />
        </div>
      </main>
    )
  }

  if (activePage === 'context') {
    return (
      <main
        data-testid="mobile-context-settings-page"
        className="flex h-dvh flex-col overflow-hidden bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
      >
        <header className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            data-testid="mobile-context-back-button"
            onClick={() => setActivePage('personal')}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
            aria-label={t('workbench.settings_back_to_app', '返回')}
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold">{t('workbench.settings_nav_context', '上下文')}</h1>
          <div className="h-11 min-w-[44px]" />
        </header>
        <div className="mt-6 min-h-0 flex-1 overflow-auto">
          <ContextSettingsPage />
        </div>
      </main>
    )
  }

  if (activePage === 'about') {
    return (
      <main
        data-testid="mobile-about-settings-page"
        className="flex h-dvh flex-col overflow-hidden bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
      >
        <header className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            data-testid="mobile-about-back-button"
            onClick={() => setActivePage('personal')}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
            aria-label={t('workbench.settings_back_to_app', '返回')}
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold">{t('workbench.settings_nav_about', '关于')}</h1>
          <div className="h-11 min-w-[44px]" />
        </header>
        <div className="mt-6 min-h-0 flex-1 overflow-auto">
          <AboutSettingsPage />
        </div>
      </main>
    )
  }

  if (activePage === 'archived-conversations') {
    return (
      <main
        data-testid="mobile-archived-conversations-settings-page"
        className="flex h-dvh flex-col overflow-hidden bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
      >
        <header className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            data-testid="mobile-archived-conversations-back-button"
            onClick={() => setActivePage('menu')}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
            aria-label={t('workbench.settings_back_to_app', '返回')}
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold">
            {t('workbench.settings_nav_archived_conversations', '已归档对话')}
          </h1>
          <div className="h-11 min-w-[44px]" />
        </header>
        <div className="mt-6 min-h-0 flex-1 overflow-auto">
          <ArchivedConversationsSettingsPage
            api={services?.runtimeWorkApi}
            onOpenRuntimeTask={onOpenRuntimeTask}
            onRefreshWorkLists={onRefreshWorkLists}
            onLeaveSettings={onBack}
          />
        </div>
      </main>
    )
  }

  if (activePage === 'harnesses' && experimentalFeaturesEnabled) {
    return (
      <main
        data-testid="mobile-harness-settings-page"
        className="flex h-dvh flex-col overflow-hidden bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
      >
        <header className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            data-testid="mobile-harness-settings-back-button"
            onClick={() => setActivePage('menu')}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
            aria-label={t('workbench.settings_back_to_app')}
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <span>{t('workbench.settings_nav_harnesses', '编码工具')}</span>
            <ExperimentalBadge testId="mobile-harness-settings-experimental-badge" />
          </h1>
          <div className="h-11 min-w-[44px]" />
        </header>
        <div className="mt-6 min-h-0 flex-1 overflow-auto">
          <HarnessSettingsPage />
        </div>
      </main>
    )
  }

  if (activePage === 'plugins') {
    return (
      <main
        data-testid="mobile-plugins-settings-page"
        className="flex h-dvh flex-col overflow-hidden bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
      >
        <header className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            data-testid="mobile-plugins-back-button"
            onClick={() => setActivePage('menu')}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
            aria-label={t('workbench.settings_back_to_app', '返回')}
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold">{t('workbench.settings_nav_plugins', '插件')}</h1>
          <div className="h-11 min-w-[44px]" />
        </header>
        <div className="mt-6 min-h-0 flex-1 overflow-auto">
          <PluginSettingsPage />
        </div>
      </main>
    )
  }

  if (activePage === 'personal') {
    return (
      <main
        data-testid="mobile-personal-settings-page"
        className="flex h-dvh flex-col overflow-hidden bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
      >
        <header className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            data-testid="mobile-personal-back-button"
            onClick={() => setActivePage('menu')}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
            aria-label={t('workbench.settings_back_to_app', '返回')}
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold">{t('workbench.settings_nav_personal', '个人')}</h1>
          <div className="h-11 min-w-[44px]" />
        </header>
        <section className="mt-8 space-y-3">
          <button
            type="button"
            data-testid="mobile-settings-general-button"
            onClick={() => setActivePage('general')}
            className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
          >
            <SlidersHorizontal className="h-5 w-5 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate">{t('workbench.settings_nav_general')}</span>
            <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
          </button>
          <button
            type="button"
            data-testid="mobile-settings-appearance-button"
            onClick={() => setActivePage('appearance')}
            className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
          >
            <Palette className="h-5 w-5 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate">
              {t('workbench.settings_nav_appearance', '外观')}
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
          </button>
          <button
            type="button"
            data-testid="mobile-settings-context-button"
            onClick={() => setActivePage('context')}
            className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
          >
            <Terminal className="h-5 w-5 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate">
              {t('workbench.settings_nav_context', '上下文')}
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
          </button>
          <button
            type="button"
            data-testid="mobile-settings-model-settings-button"
            onClick={() => setActivePage('model-settings')}
            className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
          >
            <UserRound className="h-5 w-5 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate">
              {t('workbench.settings_nav_model_settings', '模型')}
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
          </button>
          <button
            type="button"
            data-testid="mobile-settings-runtimes-button"
            onClick={() => setActivePage('runtimes')}
            className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
          >
            <Server className="h-5 w-5 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate">
              {t('workbench.settings_nav_runtimes', 'Runtime')}
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
          </button>
          <button
            type="button"
            data-testid="mobile-settings-about-button"
            onClick={() => setActivePage('about')}
            className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
          >
            <Info className="h-5 w-5 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate">
              {t('workbench.settings_nav_about', '关于')}
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
          </button>
          <button
            type="button"
            data-testid="mobile-settings-quick-phrases-button"
            onClick={() => setActivePage('quick-phrases')}
            className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
          >
            <MessageSquareText className="h-5 w-5 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate">
              {t('workbench.quick_phrases', '快捷短语')}
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
          </button>
        </section>
      </main>
    )
  }

  if (activePage === 'model-settings') {
    return (
      <main
        data-testid="mobile-model-settings-page"
        className="flex h-dvh flex-col overflow-hidden bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
      >
        <header className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            data-testid="mobile-model-settings-back-button"
            onClick={() => setActivePage('personal')}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
            aria-label={t('workbench.settings_back_to_app', '返回')}
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold">
            {t('workbench.settings_nav_model_settings', '模型')}
          </h1>
          <div className="h-11 min-w-[44px]" />
        </header>
        <div className="mt-6 min-h-0 flex-1 overflow-auto">
          <ModelSettingsPage />
        </div>
      </main>
    )
  }

  return (
    <main
      data-testid="mobile-settings-page"
      className="flex h-dvh flex-col overflow-hidden bg-[rgb(var(--color-sidebar))] px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
    >
      <header className="flex shrink-0 items-center justify-between">
        <button
          type="button"
          data-testid="mobile-settings-back-button"
          onClick={onBack}
          className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
          aria-label={t('workbench.settings_back_to_app', '返回')}
        >
          <ArrowLeft className="h-6 w-6" />
        </button>
        <h1 className="text-lg font-semibold">{t('workbench.settings', '设置')}</h1>
        <div className="h-11 min-w-[44px]" />
      </header>

      <section className="mt-8 space-y-3">
        {SHOW_PLUGINS_NAVIGATION && (
          <button
            type="button"
            data-testid="mobile-settings-plugins-button"
            onClick={onOpenPlugins}
            className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
          >
            <Plug className="h-5 w-5 shrink-0 text-text-secondary" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              {t('workbench.settings_nav_plugins', '插件')}
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
          </button>
        )}
        <button
          type="button"
          data-testid="mobile-settings-connections-button"
          onClick={() => setActivePage('connections')}
          className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
        >
          <Globe2 className="h-5 w-5 shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 truncate">
            {t('workbench.settings_nav_connections', '云端连接')}
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
        </button>
        <button
          type="button"
          data-testid="mobile-settings-personal-button"
          onClick={() => setActivePage('personal')}
          className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
        >
          <UserRound className="h-5 w-5 shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 truncate">
            {t('workbench.settings_nav_personal', '个人')}
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
        </button>
        {experimentalFeaturesEnabled ? (
          <button
            type="button"
            data-testid="mobile-settings-harnesses-button"
            onClick={() => setActivePage('harnesses')}
            className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
          >
            <Terminal className="h-5 w-5 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate">
              {t('workbench.settings_nav_harnesses', '编码工具')}
            </span>
            <ExperimentalBadge testId="mobile-settings-harnesses-experimental-badge" />
            <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
          </button>
        ) : null}
        {extensionSettingsPages.map(page => {
          const Icon = resolveDshSettingsIcon(page.icon)
          return (
            <button
              key={page.id}
              type="button"
              data-testid={`mobile-settings-${page.id}-button`}
              onClick={() => setActivePage(page.id)}
              className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
            >
              <Icon className="h-5 w-5 shrink-0 text-text-secondary" />
              <span className="min-w-0 flex-1 truncate">
                {t(`workbench.${page.labelKey ?? page.id}`, page.label)}
              </span>
              <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
            </button>
          )
        })}
        <button
          type="button"
          data-testid="mobile-settings-archived-conversations-button"
          onClick={() => setActivePage('archived-conversations')}
          className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
        >
          <Archive className="h-5 w-5 shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 truncate">
            {t('workbench.settings_nav_archived_conversations', '已归档对话')}
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
        </button>
        <button
          type="button"
          data-testid="mobile-settings-plugins-config-button"
          onClick={() => setActivePage('plugins')}
          className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
        >
          <Package className="h-5 w-5 shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 truncate">
            {t('workbench.settings_nav_plugins', '插件')}
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
        </button>
      </section>
    </main>
  )
}
