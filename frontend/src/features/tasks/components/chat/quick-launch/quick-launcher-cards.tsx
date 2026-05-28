'use client'

import type { ReactNode } from 'react'

import { useTranslation } from '@/hooks/useTranslation'

import type { QuickLauncher } from './types'

const CARD_WIDTH = 154

interface QuickLauncherCardsProps {
  systemLaunchers: QuickLauncher[]
  favoriteLaunchers: QuickLauncher[]
  selectedLauncherKey?: string | null
  onSelectLauncher: (launcher: QuickLauncher) => void
  renderMoreButton?: () => ReactNode
  renderQuickCreateCard?: () => ReactNode
}

function LauncherCard({
  launcher,
  isSelected,
  onClick,
}: {
  launcher: QuickLauncher
  isSelected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={`quick-launcher-${launcher.type}-${launcher.key.replace(':', '-')}`}
      onClick={onClick}
      className={`group relative flex h-[78px] flex-col justify-center px-3 py-2 text-left transition-all duration-200 ${
        isSelected
          ? 'border-l-[3px] border-l-primary border-y border-r border-border bg-primary/5'
          : 'border border-border bg-base hover:bg-hover hover:shadow-[0_2px_12px_0_rgba(0,0,0,0.1)]'
      }`}
      style={{
        width: CARD_WIDTH,
        borderRadius: 20,
        flexShrink: 0,
      }}
    >
      <span
        className={`block truncate text-[15px] font-semibold leading-5 ${
          isSelected ? 'text-primary' : 'text-text-primary'
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
  selectedLauncherKey,
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
          <div
            className="flex flex-wrap items-center justify-start gap-3"
            data-testid="quick-launch-system-grid"
          >
            {systemLaunchers.map(launcher => (
              <LauncherCard
                key={launcher.key}
                launcher={launcher}
                isSelected={launcher.key === selectedLauncherKey}
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
          <div
            className="flex flex-wrap items-center justify-start gap-3"
            data-testid="quick-launch-favorites-grid"
          >
            {favoriteLaunchers.map(launcher => (
              <LauncherCard
                key={launcher.key}
                launcher={launcher}
                isSelected={launcher.key === selectedLauncherKey}
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
