// Reorder real transport delivery without fabricating executor responses or conversation state.
type Phase = 'request' | 'response'
interface RuntimeInputTransportGate {
  phase: Phase
  held: boolean
  claimed: boolean
  released: boolean
  accepted: boolean | null
  release: () => void
}
let gate: RuntimeInputTransportGate | null = null
let restoreFetch: (() => void) | null = null

export function releaseRuntimeInputTransportGate(): void {
  gate?.release()
  restoreFetch?.()
  restoreFetch = null
}

export function armRuntimeInputTransportGate(phase: string): void {
  if (import.meta.env.MODE !== 'e2e' && import.meta.env.VITE_WEWORK_E2E !== 'true') {
    throw new Error('Runtime input transport gates are only available in E2E mode')
  }
  if (phase !== 'request' && phase !== 'response') throw new Error('Unknown transport gate phase')
  releaseRuntimeInputTransportGate()
  let release!: () => void
  const barrier = new Promise<void>(resolve => {
    release = resolve
  })
  const current: RuntimeInputTransportGate = {
    phase,
    held: false,
    claimed: false,
    released: false,
    accepted: null as boolean | null,
    release() {
      current.released = true
      release()
    },
  }
  gate = current
  const original = window.fetch
  const wrapped: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let matches = false
    if (url.endsWith('/wework/executor/v1/rpc') && typeof init?.body === 'string') {
      const payload = JSON.parse(init.body)
      matches =
        payload.method === 'runtime.tasks.send' &&
        Boolean(
          payload.params?.requestUserInputResponse ?? payload.params?.request_user_input_response
        )
    }
    if (!matches || current.claimed || current.released) return original.call(window, input, init)
    current.claimed = true
    const abort = () => {
      if (gate === current) releaseRuntimeInputTransportGate()
      else current.release()
    }
    const signal = init?.signal
    signal?.addEventListener('abort', abort, { once: true })
    const hold = async () => {
      current.held = true
      if (signal?.aborted) abort()
      await barrier
      signal?.throwIfAborted()
    }
    try {
      if (phase === 'request') await hold()
      const response = await original.call(window, input, init)
      const body = await response.clone().json()
      current.accepted = body.ok === true && body.result?.accepted === true
      if (phase === 'response') await hold()
      return response
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }
  window.fetch = wrapped
  restoreFetch = () => {
    if (window.fetch === wrapped) window.fetch = original
  }
}

export function readRuntimeInputTransportGate(): string {
  return JSON.stringify(
    gate && {
      phase: gate.phase,
      held: gate.held,
      released: gate.released,
      accepted: gate.accepted,
    }
  )
}
