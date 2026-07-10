import {
  Archive,
  ArrowLeft,
  ChevronRight,
  GitBranch,
  Info,
  Package,
  Palette,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  UserRound,
} from 'lucide-react'
import { useState } from 'react'
import { AppearanceSettingsPage } from '@/features/appearance/AppearanceSettingsPage'
import { SHOW_PLUGINS_NAVIGATION } from '@/features/plugins/visibility'
import { useTranslation } from '@/hooks/useTranslation'
import { GeneralSettingsPage } from './GeneralSettingsPage'
import { ContextSettingsPage } from './ContextSettingsPage'
import { ModelSettingsPage } from './ModelSettingsPage'
import { SkillSettingsPage } from './SkillSettingsPage'
import { WorktreesSettingsPage } from './WorktreesSettingsPage'
import { ArchivedConversationsSettingsPage } from './ArchivedConversationsSettingsPage'
import { AboutSettingsPage } from './AboutSettingsPage'

interface MobileSettingsPageProps {
  onBack: () => void
  onOpenPlugins?: () => void
}

export function MobileSettingsPage({ onBack, onOpenPlugins }: MobileSettingsPageProps) {
  const { t } = useTranslation('common')
  const [activePage, setActivePage] = useState<
    | 'menu'
    | 'general'
    | 'appearance'
    | 'context'
    | 'about'
    | 'personal'
    | 'model-settings'
    | 'skills'
    | 'worktrees'
    | 'archived-conversations'
  >('menu')

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
            onClick={() => setActivePage('menu')}
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
            onClick={() => setActivePage('menu')}
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
            onClick={() => setActivePage('menu')}
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

  if (activePage === 'worktrees') {
    return (
      <main
        data-testid="mobile-worktrees-settings-page"
        className="flex h-dvh flex-col overflow-hidden bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
      >
        <header className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            data-testid="mobile-worktrees-back-button"
            onClick={() => setActivePage('menu')}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
            aria-label={t('workbench.settings_back_to_app', '返回')}
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold">{t('workbench.worktrees_title', '工作树')}</h1>
          <div className="h-11 min-w-[44px]" />
        </header>
        <div className="mt-6 min-h-0 flex-1 overflow-auto">
          <WorktreesSettingsPage />
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
            onClick={() => setActivePage('menu')}
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
          <ArchivedConversationsSettingsPage />
        </div>
      </main>
    )
  }

  if (activePage === 'skills') {
    return (
      <main
        data-testid="mobile-skills-settings-page"
        className="flex h-dvh flex-col overflow-hidden bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
      >
        <header className="flex shrink-0 items-center justify-between">
          <button
            type="button"
            data-testid="mobile-skills-back-button"
            onClick={() => setActivePage('menu')}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface text-text-primary hover:bg-muted"
            aria-label={t('workbench.settings_back_to_app', '返回')}
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-semibold">{t('workbench.settings_nav_skills', '技能')}</h1>
          <div className="h-11 min-w-[44px]" />
        </header>
        <div className="mt-6 min-h-0 flex-1 overflow-auto">
          <SkillSettingsPage />
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
        {SHOW_PLUGINS_NAVIGATION && (
          <button
            type="button"
            data-testid="mobile-settings-plugins-button"
            onClick={onOpenPlugins}
            className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
          >
            <Sparkles className="h-5 w-5 shrink-0 text-text-secondary" />
            <span className="min-w-0 flex-1 truncate">
              {t('workbench.settings_nav_plugins', '插件')}
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
          </button>
        )}
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
          data-testid="mobile-settings-worktrees-button"
          onClick={() => setActivePage('worktrees')}
          className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
        >
          <GitBranch className="h-5 w-5 shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 truncate">
            {t('workbench.settings_nav_worktrees', '工作树')}
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
        </button>
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
          data-testid="mobile-settings-skills-button"
          onClick={() => setActivePage('skills')}
          className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-surface px-4 text-left text-base font-medium text-text-primary hover:bg-muted"
        >
          <Package className="h-5 w-5 shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 truncate">
            {t('workbench.settings_nav_skills', '技能')}
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-text-muted" />
        </button>
      </section>
    </main>
  )
}
