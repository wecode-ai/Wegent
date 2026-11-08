import {
  nativeBackgroundColor,
  normalizeAppearanceThemeSnapshot,
  type AppearanceThemeMode,
  type AppearanceThemeVariantSnapshot,
} from './appearance-theme-contract.js'

export interface ResolvedHostAppearance extends AppearanceThemeVariantSnapshot {
  mode: AppearanceThemeMode
  backgroundColor: string
}

interface AppearanceWindow {
  isDestroyed: () => boolean
  setBackgroundColor: (color: string) => void
}

interface AppearanceHost {
  nativeTheme: {
    themeSource: AppearanceThemeMode | 'system'
    readonly shouldUseDarkColors: boolean
  }
  windows: () => Array<AppearanceWindow | null>
}

const DEFAULT_VARIABLES = {
  light: {
    '--color-bg-base': '255 255 255',
    '--color-bg-surface': '247 247 248',
    '--color-text-primary': '26 26 26',
    '--color-text-secondary': '96 99 104',
    '--color-text-muted': '138 143 152',
    '--color-border': '224 224 224',
    '--color-primary': '37 99 235',
    '--color-primary-contrast': '255 255 255',
    '--color-success': '0 162 64',
    '--color-destructive': '220 38 38',
    '--color-destructive-contrast': '255 255 255',
    '--color-link': '37 99 235',
  },
  dark: {
    '--color-bg-base': '24 24 24',
    '--color-bg-surface': '33 33 33',
    '--color-text-primary': '255 255 255',
    '--color-text-secondary': '179 179 179',
    '--color-text-muted': '128 128 128',
    '--color-border': '43 43 43',
    '--color-primary': '37 99 235',
    '--color-primary-contrast': '255 255 255',
    '--color-success': '64 201 119',
    '--color-destructive': '248 113 113',
    '--color-destructive-contrast': '0 0 0',
    '--color-link': '37 99 235',
  },
}

export function resolveHostAppearance(
  preferences: Record<string, unknown>,
  systemUsesDarkColors: boolean
): ResolvedHostAppearance {
  const requestedMode = preferences.appearanceMode
  const mode =
    requestedMode === 'light' || requestedMode === 'dark'
      ? requestedMode
      : systemUsesDarkColors
        ? 'dark'
        : 'light'
  const saved = normalizeAppearanceThemeSnapshot(preferences.appearanceThemeSnapshot)?.[mode]
  const variables = { ...DEFAULT_VARIABLES[mode], ...saved?.variables }
  return {
    mode,
    themeId: saved?.themeId ?? 'wework',
    variables,
    backgroundColor: nativeBackgroundColor(variables['--color-bg-base'])!,
  }
}

/** Keeps opaque workbench windows on the selected palette after startup. */
export class DesktopAppearanceController {
  private preferences: Record<string, unknown> = {}

  constructor(private readonly host: AppearanceHost) {}

  current(): ResolvedHostAppearance {
    return resolveHostAppearance(this.preferences, this.host.nativeTheme.shouldUseDarkColors)
  }

  update(preferences = this.preferences): void {
    this.preferences = preferences
    const mode = preferences.appearanceMode
    const source = mode === 'light' || mode === 'dark' ? mode : 'system'
    if (this.host.nativeTheme.themeSource !== source) this.host.nativeTheme.themeSource = source
    const appearance = this.current()
    for (const window of this.host.windows()) {
      if (!window || window.isDestroyed()) continue
      window.setBackgroundColor(appearance.backgroundColor)
    }
  }
}
