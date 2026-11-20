import { createPortal } from 'react-dom'
import { useCallback, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { useDocumentEvent, useWindowEvent } from '@wegent/collaboration/dom-events'
import { createIconButtonTooltipController } from './iconButtonTooltipController'

const VIEWPORT_PADDING_PX = 8
const TRIGGER_GAP_PX = 8

export function GlobalIconButtonTooltip() {
  const [controller] = useState(createIconButtonTooltipController)
  const { target, visible } = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [placement, setPlacement] = useState<{
    target: typeof target
    style: CSSProperties
  } | null>(null)
  useDocumentEvent('pointerover', controller.pointerOver)
  useDocumentEvent('pointerout', controller.pointerOut)
  useDocumentEvent('focusin', controller.focusIn)
  useDocumentEvent('focusout', controller.focusOut)
  useDocumentEvent('click', controller.hide, { capture: true })
  useDocumentEvent('keydown', controller.keyDown)
  useWindowEvent('resize', controller.hide)
  useWindowEvent('scroll', controller.hide, { capture: true })

  const measureTooltip = useCallback(
    (node: HTMLSpanElement | null) => {
      if (!node || !target) return
      const triggerRect = target.button.getBoundingClientRect()
      const tooltipRect = node.getBoundingClientRect()
      const preferredTop = triggerRect.bottom + TRIGGER_GAP_PX
      const alternateTop = triggerRect.top - tooltipRect.height - TRIGGER_GAP_PX
      const top =
        preferredTop + tooltipRect.height <= window.innerHeight - VIEWPORT_PADDING_PX
          ? preferredTop
          : Math.max(VIEWPORT_PADDING_PX, alternateTop)
      const centeredLeft = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2
      const left = Math.min(
        Math.max(centeredLeft, VIEWPORT_PADDING_PX),
        window.innerWidth - tooltipRect.width - VIEWPORT_PADDING_PX
      )
      setPlacement({ target, style: { left, top } })
    },
    [target]
  )
  const position = placement?.target === target ? placement?.style : undefined

  if (!visible || !target) return null

  return createPortal(
    <span
      ref={measureTooltip}
      role="tooltip"
      data-testid="global-icon-button-tooltip"
      style={position}
      className={`pointer-events-none fixed z-system-popover max-w-[20rem] whitespace-normal break-words rounded-lg border border-border/70 bg-popover/95 px-2 py-1 text-sm leading-5 text-text-primary shadow-[0_10px_28px_rgba(0,0,0,0.18)] backdrop-blur-md ${
        position ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {target.label}
    </span>,
    document.body
  )
}
