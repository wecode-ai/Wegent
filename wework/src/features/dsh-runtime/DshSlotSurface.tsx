import { useEffect, useMemo, useRef } from 'react'

import { attachDshSlot, type WeworkDshSlotMount, type WeworkDshSlotName } from './dshUiSlots'

interface DshSlotSurfaceProps {
  className?: string
  enabled?: boolean
  entryId?: string
  props?: object
  slot: WeworkDshSlotName
  testId?: string
}

export function DshSlotSurface({
  className,
  enabled = true,
  entryId,
  props = {},
  slot,
  testId,
}: DshSlotSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mountRef = useRef<WeworkDshSlotMount | null>(null)
  const stableProps = useMemo(() => props, [props])
  const propsRef = useRef(stableProps)

  useEffect(() => {
    propsRef.current = stableProps
  }, [stableProps])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) return
    const mount = attachDshSlot(slot, entryId, container, propsRef.current)
    if (!mount) return
    mountRef.current = mount
    return () => {
      if (mountRef.current === mount) mountRef.current = null
      mount.dispose()
    }
  }, [enabled, entryId, slot])

  useEffect(() => {
    mountRef.current?.update(stableProps)
  }, [stableProps])

  return <div ref={containerRef} className={className} data-testid={testId} />
}
