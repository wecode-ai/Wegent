export type ModelControlLayer = 'composer' | 'quick'

export type ModelControlEvent = 'openQuick' | 'close'

export function reduceModelControlLayer(
  layer: ModelControlLayer,
  event: ModelControlEvent
): ModelControlLayer {
  if (event === 'close') return 'composer'
  if (event === 'openQuick' && layer === 'composer') return 'quick'
  return layer
}
