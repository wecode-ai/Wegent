import { bindLayer, createFocusRecovery } from '@ui-sdk/core'
import {
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
} from 'react'

interface InlinePanelProps extends ComponentProps<'section'> {
  onEscape(): void
  active?: boolean
  restoreFocus?: string
}

export function InlinePanel({
  children,
  onEscape,
  active = true,
  restoreFocus,
  ref,
  ...props
}: InlinePanelProps) {
  const element = useRef<HTMLElement>(null)
  const key = useId()
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
  )
  const [recovery] = useState(() =>
    createFocusRecovery<{ opener: HTMLElement | null; restoreFocus?: string }>({
      fallback: lost => {
        const opener = lost.props.opener
        if (
          opener?.isConnected &&
          opener !== lost.el.ownerDocument.body &&
          !opener.closest('[hidden], [inert]') &&
          !opener.matches(':disabled')
        )
          return opener
        return lost.props.restoreFocus
          ? lost.el.ownerDocument.querySelector<HTMLElement>(lost.props.restoreFocus)
          : null
      },
    })
  )
  useImperativeHandle(ref, () => element.current!)
  const dismiss = useEffectEvent(onEscape)
  useLayoutEffect(() => {
    const panel = element.current
    if (!active || !panel) return
    const focusOwner = restoreFocus
      ? (panel.closest<HTMLElement>('[role="dialog"]') ?? panel)
      : panel
    const restore = recovery.bind(focusOwner, {
      key,
      props: { opener, restoreFocus },
    })
    const unbind = bindLayer(panel, {
      onDismiss: (reason, event) => {
        if (reason !== 'escape-key') return
        event.preventDefault()
        dismiss()
      },
    })
    panel.focus({ preventScroll: true })
    return () => {
      unbind()
      restore()
    }
  }, [active, key, opener, recovery, restoreFocus])
  return (
    <section {...props} ref={element} tabIndex={-1} hidden={!active || props.hidden}>
      {children}
    </section>
  )
}
