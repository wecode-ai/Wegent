import { useState } from 'react'

function createPaneHost(id: string): HTMLDivElement {
  const host = document.createElement('div')
  host.className = 'h-full min-h-0 min-w-0'
  host.dataset.experiencePaneHost = id
  return host
}

export function useExperiencePaneHosts(signature: string) {
  const [state, setState] = useState(() => ({
    signature,
    hosts: new Map(
      signature
        .split('\u0000')
        .filter(Boolean)
        .map(id => [id, createPaneHost(id)])
    ),
  }))

  if (state.signature !== signature) {
    const ids = signature.split('\u0000').filter(Boolean)
    const next = {
      signature,
      hosts: new Map(ids.map(id => [id, state.hosts.get(id) ?? createPaneHost(id)])),
    }
    setState(next)
    return next.hosts
  }

  return state.hosts
}
