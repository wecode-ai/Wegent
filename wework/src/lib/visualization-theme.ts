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
