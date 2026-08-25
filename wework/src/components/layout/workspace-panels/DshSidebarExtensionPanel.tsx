import { useEffect, useMemo, useRef } from 'react'
import type {
  WeworkWorkspaceScope,
  WeworkWorkspaceSidebarTab,
  WeworkWorkspaceSidebarTabDescriptor,
} from './rightWorkspaceSidebarRegistry'
import {
  rightWorkspaceBetterSidebar,
  rightWorkspaceExtensionContext,
} from './rightWorkspaceSidebarRegistry'

interface DshSidebarExtensionPanelProps {
  descriptor: WeworkWorkspaceSidebarTabDescriptor
  scope: WeworkWorkspaceScope
  tab: WeworkWorkspaceSidebarTab
  visible: boolean
}

export function DshSidebarExtensionPanel({
  descriptor,
  scope,
  tab,
  visible,
}: DshSidebarExtensionPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef<ReturnType<NonNullable<typeof descriptor.mount>> | null>(null)
  const props = useMemo(
    () => ({
      ctx: rightWorkspaceExtensionContext,
      store: rightWorkspaceBetterSidebar,
      scope,
      tab,
      visible,
    }),
    [scope, tab, visible]
  )
  const propsRef = useRef(props)

  useEffect(() => {
    propsRef.current = props
  }, [props])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !descriptor.mount || !visible) return
    const mounted = descriptor.mount(container, propsRef.current)
    mountedRef.current = mounted
    return () => {
      mountedRef.current = null
      mounted.dispose()
    }
  }, [descriptor, visible])

  useEffect(() => {
    mountedRef.current?.update(props)
  }, [props])

  if (!descriptor.mount && descriptor.component) {
    return descriptor.component(props)
  }

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 flex-1 flex-col"
      data-testid={`dsh-sidebar-extension-surface-${descriptor.id}`}
    />
  )
}
