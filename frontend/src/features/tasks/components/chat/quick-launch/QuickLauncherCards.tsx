'use client'

import type { ReactNode } from 'react'

import { useTranslation } from '@/hooks/useTranslation'

import type { QuickLauncher } from './types'

const CARD_WIDTH = 154

interface QuickLauncherCardsProps {
  systemLaunchers: QuickLauncher[]
  favoriteLaunchers: QuickLauncher[]
  onSelectLauncher: (launcher: QuickLauncher) => void
  renderMoreButton?: () => ReactNode
  renderQuickCreateCard?: () => ReactNode
}

function LauncherCard({
  launcher,
  accent,
  onClick,
}: {
  launcher: QuickLauncher
  accent: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={`quick-launcher-${launcher.type}-${launcher.key.replace(':', '-')}`}
      onClick={onClick}
      className={`group relative flex h-[78px] flex-col justify-center rounded-lg px-3 py-2 text-left transition-all duration-200 ${
        accent
          ? 'border border-primary/25 bg-primary/5 hover:border-primary/50'
          : 'border border-border bg-base hover:bg-hover'
      } hover:shadow-sm`}
      style={{
        width: CARD_WIDTH,
        flexShrink: 0,
      }}
    >
      <span
        className={`block truncate text-[15px] font-semibold leading-5 ${
          accent ? 'text-primary' : 'text-text-primary'
        }`}
        title={launcher.title}
      >
        {launcher.title}
      </span>
      {launcher.description && (
        <span
          className="mt-1 block truncate text-xs leading-[18px] text-text-muted"
          title={launcher.description}
        >
          {launcher.description}
        </span>
      )}
    </button>
  )
}

export function QuickLauncherCards({
  systemLaunchers,
  favoriteLaunchers,
  onSelectLauncher,
  renderMoreButton,
  renderQuickCreateCard,
}: QuickLauncherCardsProps) {
  const { t } = useTranslation('chat')

  return (
    <div className="mx-auto mt-6 w-full max-w-[820px] space-y-3" data-testid="quick-launch-cards">
      {systemLaunchers.length > 0 && (
        <section className="space-y-2" data-testid="quick-launch-system-row">
          <h3 className="px-1 text-xs font-medium text-text-muted">
            {t('quick_launch.system_functions')}
          </h3>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {systemLaunchers.map(launcher => (
              <LauncherCard
                key={launcher.key}
                launcher={launcher}
                accent
                onClick={() => onSelectLauncher(launcher)}
              />
            ))}
          </div>
        </section>
      )}

      {(favoriteLaunchers.length > 0 || renderMoreButton || renderQuickCreateCard) && (
        <section className="space-y-2" data-testid="quick-launch-favorites-row">
          <h3 className="px-1 text-xs font-medium text-text-muted">
            {t('quick_launch.favorite_agents')}
          </h3>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {favoriteLaunchers.map(launcher => (
              <LauncherCard
                key={launcher.key}
                launcher={launcher}
                accent={false}
                onClick={() => onSelectLauncher(launcher)}
              />
            ))}
            {renderMoreButton?.()}
            {renderQuickCreateCard?.()}
          </div>
        </section>
      )}
    </div>
  )
}
