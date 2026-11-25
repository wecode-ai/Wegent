import {
  replyPredictionKey,
  type ReplyPredictionResult,
  type ReplyPredictionService,
  type ReplyPredictionSource,
} from './replyPredictionService'

interface PredictionSnapshot {
  prediction: ReplyPredictionResult | null
  pending: boolean
}

/** One request identity owns its candidate and observes the shared service's actual pending state. */
function createPredictionView(service: ReplyPredictionService, source: ReplyPredictionSource) {
  let snapshot: PredictionSnapshot = { prediction: null, pending: false }
  const listeners = new Set<() => void>()
  let generation = 0
  let unsubscribe: (() => void) | undefined
  let release: (() => void) | undefined
  const getSnapshot = () => {
    const prediction = snapshot.prediction?.isCurrent() ? snapshot.prediction : null
    const pending = !source.busy && service.isPending(source.scope)
    if (prediction !== snapshot.prediction || pending !== snapshot.pending)
      snapshot = { prediction, pending }
    return snapshot
  }
  const publish = (prediction?: ReplyPredictionResult | null) => {
    const previous = snapshot
    if (prediction !== undefined && prediction !== snapshot.prediction)
      snapshot = { ...snapshot, prediction }
    getSnapshot()
    if (snapshot !== previous) listeners.forEach(listener => listener())
  }
  return {
    getSnapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        unsubscribe = service.subscribe(scope => {
          if (scope === undefined || scope === source.scope) publish()
        })
        if (source.busy) {
          service.invalidate(source.scope)
        } else {
          const request = ++generation
          release = service.retain(source.scope)
          void service.request(source).then(
            prediction => {
              if (request === generation && listeners.size) publish(prediction)
            },
            () => {
              if (request === generation && listeners.size) publish(null)
            }
          )
        }
        publish()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        generation += 1
        unsubscribe?.()
        unsubscribe = undefined
        release?.()
        release = undefined
      }
    },
    accept() {
      const prediction = getSnapshot().prediction
      if (!listeners.size || !prediction) return
      prediction.onAccept()
      publish(null)
    },
  }
}

/** Memoize resource identity without updating a request or its UI state during render. */
export function createReplyPredictionViews() {
  let binding:
    | {
        service: ReplyPredictionService
        key: string
        busy: boolean
        view: ReturnType<typeof createPredictionView>
      }
    | undefined
  return {
    resolve(service: ReplyPredictionService | null, source: ReplyPredictionSource | null) {
      if (!service || !source) return null
      const key = replyPredictionKey(source)
      if (binding?.service === service && binding.key === key && binding.busy === source.busy)
        return binding.view
      const view = createPredictionView(service, source)
      binding = { service, key, busy: source.busy, view }
      return view
    },
  }
}
