import { createE2ELifecycleTrace } from '@/e2e/lifecycleTrace'
import { setActiveWorkspaceTabPortalOwner } from '@/components/topnav/workspaceTabPortalOwnership'

interface SurfaceDescriptor {
  appId: string
  hasModule: boolean
  tabId: string
  active: boolean
}
interface SurfaceBindingInput {
  active: boolean
  tabId: string
  native?: SurfaceDescriptor
  surface?: SurfaceDescriptor
}

/** The actual workspace host commits portal ownership and its mounted DSH surface metadata. */
export function createWorkspaceTabSurfaceBinding() {
  let element: HTMLElement | undefined
  let lease: object | undefined
  const traces = new Map<string, ReturnType<typeof createE2ELifecycleTrace>>()
  function release() {
    for (const trace of traces.values()) trace.dispose()
    traces.clear()
    element = undefined
  }
  return {
    attach(node: HTMLDivElement, input: SurfaceBindingInput) {
      if (element && element !== node) release()
      element = node
      const owner = {}
      lease = owner
      if (input.active) setActiveWorkspaceTabPortalOwner(input.tabId)
      for (const kind of ['native', 'surface'] as const) {
        const descriptor = input[kind]
        if (descriptor) {
          let trace = traces.get(kind)
          if (!trace) {
            trace = createE2ELifecycleTrace('DshAppSurface')
            traces.set(kind, trace)
          }
          trace.update(descriptor)
        } else {
          traces.get(kind)?.dispose()
          traces.delete(kind)
        }
      }
      return () => {
        if (lease !== owner) return
        lease = undefined
        queueMicrotask(() => {
          if (!lease) release()
        })
      }
    },
  }
}
