import { memo } from 'react'
import { ChevronDown } from 'lucide-react'
import { useOptionalAppearance } from '@/features/appearance'
import type { PluginMarketplaceItem } from '@/types/api'
import { resolvePluginLogo } from '../plugin-assets'
import { marketplacePluginDistribution } from '../pluginDistribution'
import { PluginSourceAvatar } from '../PluginSourceAvatar'

export const PluginMarketplaceRevealButton = memo(function PluginMarketplaceRevealButton({
  items,
  label,
  testId = 'plugins-show-more-button',
  onReveal,
}: {
  items: PluginMarketplaceItem[]
  label: string
  testId?: string
  onReveal: () => void
}) {
  const appearanceMode = useOptionalAppearance()?.resolvedMode ?? 'light'
  return (
    <button
      type="button"
      data-testid={testId}
      className="plugin-market-reveal-button"
      aria-label={label}
      onClick={onReveal}
    >
      <span className="plugin-market-reveal-icons" aria-hidden="true">
        {items.slice(0, 3).map(item => {
          const logo = resolvePluginLogo({
            pluginKey: item.name,
            logo: item.interface?.logo,
            logoDark: item.interface?.logoDark,
            composerIcon: item.interface?.composerIcon,
            appearanceMode,
          })
          return (
            <PluginSourceAvatar
              key={item.id}
              className={[
                'plugin-market-reveal-logo',
                logo.source === 'provided' ? 'plugin-logo-provided' : 'plugin-logo-fallback',
              ].join(' ')}
              contrastPad={logo.contrastPad}
              distribution={marketplacePluginDistribution(item)}
              logoUrl={logo.url}
              name={item.displayName || item.name}
              useInitial={logo.source === 'fallback'}
            />
          )
        })}
      </span>
      <span className="plugin-market-reveal-copy">{label}</span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </button>
  )
})
