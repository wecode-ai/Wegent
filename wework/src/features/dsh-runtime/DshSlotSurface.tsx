import { useMemo, useState } from 'react'

import { attachDshSlot, type WeworkDshSlotMount, type WeworkDshSlotName } from './dshUiSlots'

const EMPTY_SLOT_PROPS = Object.freeze({})

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
  props = EMPTY_SLOT_PROPS,
  slot,
  testId,
}: DshSlotSurfaceProps) {
  const [binding] = useState(createSlotBinding)
  const containerRef = useMemo(
    () => (node: HTMLDivElement | null) => {
      if (node) return binding.attach(node, { enabled, entryId, slot, props })
    },
    [binding, enabled, entryId, slot, props]
  )
  return <div ref={containerRef} className={className} data-testid={testId} />
}

interface SlotBindingInput {
  enabled: boolean
  entryId?: string
  slot: WeworkDshSlotName
  props: object
}

/** The actual native container owns one plugin mount across same-commit prop handoffs. */
function createSlotBinding() {
  let lease: object | undefined
  let current: { node: HTMLElement; input: SlotBindingInput; mount: WeworkDshSlotMount } | undefined
  return {
    attach(node: HTMLElement, input: SlotBindingInput) {
      const owner = {}
      lease = owner
      if (
        current &&
        input.enabled &&
        current.node === node &&
        current.input.slot === input.slot &&
        current.input.entryId === input.entryId
      ) {
        if (current.input.props !== input.props) current.mount.update(input.props)
        current.input = input
      } else {
        current?.mount.dispose()
        current = undefined
        const mount = input.enabled
          ? attachDshSlot(input.slot, input.entryId, node, input.props)
          : null
        if (mount) current = { node, input, mount }
      }
      return () => {
        if (lease !== owner) return
        lease = undefined
        queueMicrotask(() => {
          if (lease) return
          const previous = current
          current = undefined
          previous?.mount.dispose()
        })
      }
    },
  }
}
