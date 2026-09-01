export type ModelControlLayer = 'composer' | 'quick'

export type ModelControlEvent = 'openQuick' | 'close'

export interface ModelControlAppearance {
  backdropColor: string
  colorScheme: 'dark' | 'light'
  groupBackgroundColor: string
  groupTintColor: string
  menuBackgroundColor: string
  menuTintColor: string
}

export function modelControlAppearance(dark: boolean): ModelControlAppearance {
  if (dark) {
    return {
      backdropColor: 'rgba(0,0,0,0.34)',
      colorScheme: 'dark',
      groupBackgroundColor: 'rgba(60,60,60,0.42)',
      groupTintColor: '#303030',
      menuBackgroundColor: 'rgba(36,36,36,0.74)',
      menuTintColor: '#252525',
    }
  }
  return {
    backdropColor: 'rgba(0,0,0,0.18)',
    colorScheme: 'light',
    groupBackgroundColor: 'rgba(248,248,248,0.72)',
    groupTintColor: '#eeeeee',
    menuBackgroundColor: 'rgba(248,248,248,0.86)',
    menuTintColor: '#f4f4f4',
  }
}

export function reduceModelControlLayer(
  layer: ModelControlLayer,
  event: ModelControlEvent
): ModelControlLayer {
  if (event === 'close') return 'composer'
  if (event === 'openQuick' && layer === 'composer') return 'quick'
  return layer
}
