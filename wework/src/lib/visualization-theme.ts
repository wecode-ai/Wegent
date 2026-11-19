const COLOR_TOKENS = {
  background: 'bg-base',
  foreground: 'text-primary',
  card: 'bg-surface',
  'card-foreground': 'text-primary',
  primary: 'primary',
  'primary-foreground': 'primary-contrast',
  secondary: 'muted',
  'secondary-foreground': 'text-primary',
  muted: 'muted',
  'muted-foreground': 'text-secondary',
  accent: 'bg-hover',
  'accent-foreground': 'primary',
  destructive: 'destructive',
  border: 'border',
  input: 'border',
  ring: 'focus',
  'viz-series-1': 'terminal-blue',
  'viz-series-2': 'terminal-yellow',
  'viz-series-3': 'terminal-green',
  'viz-series-4': 'terminal-magenta',
  'viz-series-5': 'terminal-cyan',
  'viz-series-6': 'terminal-red',
} as const

export const VISUALIZATION_THEME_PROPERTIES = [
  ...Object.keys(COLOR_TOKENS).map(key => `--${key}`),
  '--font-size-base',
  '--font-sans',
]

export function readVisualizationThemeVariables(): Record<string, string> {
  // Wework uses the original host defaults and the fragment's authored palette.
  if (document.documentElement.dataset.appearanceTheme === 'wework') return {}
  const style = window.getComputedStyle(document.documentElement)
  const variables: Record<string, string> = {}
  for (const [property, token] of Object.entries(COLOR_TOKENS)) {
    const color = style.getPropertyValue(`--color-${token}`).trim()
    if (color) variables[`--${property}`] = `rgb(${color})`
  }
  for (const [property, token] of [
    ['--font-size-base', '--font-size-ui'],
    ['--font-sans', '--font-ui'],
  ]) {
    const value = style.getPropertyValue(token).trim()
    if (value) variables[property] = value
  }
  return variables
}

export interface VisualizationThemeSnapshot {
  mode: 'light' | 'dark'
  variables: Record<string, string>
}

/** Observe the committed host palette without replacing a visualization document. */
export function createVisualizationThemeObservation(initialMode: 'light' | 'dark') {
  const initialSnapshot: VisualizationThemeSnapshot = { mode: initialMode, variables: {} }
  let snapshot = initialSnapshot
  let mode = initialMode
  let observer: MutationObserver | undefined
  const listeners = new Set<() => void>()
  const update = () => {
    const variables = readVisualizationThemeVariables()
    if (snapshot.mode === mode && JSON.stringify(snapshot.variables) === JSON.stringify(variables))
      return
    snapshot = { mode, variables }
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initialSnapshot,
    subscribe(listener: () => void, nextMode: 'light' | 'dark') {
      listeners.add(listener)
      mode = nextMode
      if (!observer) {
        observer = new MutationObserver(update)
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['style', 'class', 'data-theme', 'data-appearance-theme'],
        })
      }
      update()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          observer?.disconnect()
          observer = undefined
        }
      }
    },
  }
}
