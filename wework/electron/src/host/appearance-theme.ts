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
    '--color-bg-surface': '252 252 252',
    '--color-text-primary': '13 13 13',
    '--color-text-secondary': '74 74 74',
    '--color-text-muted': '122 122 122',
    '--color-border': '224 224 224',
    '--color-primary': '1 105 204',
    '--color-primary-contrast': '255 255 255',
    '--color-success': '0 162 64',
    '--color-destructive': '224 46 42',
    '--color-destructive-contrast': '255 255 255',
    '--color-link': '1 105 204',
  },
  dark: {
    '--color-bg-base': '17 17 17',
    '--color-bg-surface': '19 19 19',
    '--color-text-primary': '252 252 252',
    '--color-text-secondary': '193 193 193',
    '--color-text-muted': '146 146 146',
    '--color-border': '50 50 50',
    '--color-primary': '1 105 204',
    '--color-primary-contrast': '255 255 255',
    '--color-success': '0 162 64',
    '--color-destructive': '224 46 42',
    '--color-destructive-contrast': '255 255 255',
    '--color-link': '1 105 204',
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
    themeId: saved?.themeId ?? 'codex',
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
