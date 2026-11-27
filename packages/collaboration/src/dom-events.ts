import {
  stopConversationFrameProbe,
  type ConversationFrameProbeState,
} from './conversation/conversationFrameProbe'
import {
  createConversationSearchHighlightBinding,
  type ConversationSearchHighlightOptions,
} from './conversation/conversationSearchHighlightBinding'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { flushSync } from 'react-dom'
import { observeReadableScrollRequest, type ReadableScrollMemory } from './readableScrollRequest'
import { focusEditorTarget, type EditorFocusTarget, type EditorFocusGuard } from './editorFocus'
import { isolateModalBackground } from './controls/dialogAccessibility'
import { isImeComposingEvent } from '@wegent/chat-core/ime'
export { focusEditorTarget } from './editorFocus'
export type { EditorFocusTarget, EditorFocusGuard } from './editorFocus'

/** Keep a document-level style flag for the lifetime of each mounted owner. */
export function createBodyFlagRef(attribute: string) {
  const ownersByBody = new WeakMap<HTMLElement, number>()
  return (element: HTMLElement | null) => {
    if (!element) return
    const body = element.ownerDocument.body
    const owners = ownersByBody.get(body) ?? 0
    ownersByBody.set(body, owners + 1)
    if (owners === 0) body.setAttribute(attribute, '')
    return () => {
      const remaining = (ownersByBody.get(body) ?? 1) - 1
      if (remaining > 0) ownersByBody.set(body, remaining)
      else {
        ownersByBody.delete(body)
        body.removeAttribute(attribute)
      }
    }
  }
}

export interface DomEventOptions extends AddEventListenerOptions {
  enabled?: boolean
}
type DomEventTarget = EventTarget | 'window' | 'document' | null

/** Own one native listener; preserve browser capture, passive, once and abort semantics. */
export function useDOMEvent<E extends Event>(
  target: DomEventTarget,
  type: string,
  listener: (event: E) => void,
  { enabled = true, capture = false, passive, once, signal }: DomEventOptions = {}
): void {
  const latest = useRef(listener)
  useEffect(() => {
    latest.current = listener
  }, [listener])
  useEffect(() => {
    if (!enabled) return
    const owner =
      target === 'window'
        ? typeof window === 'undefined'
          ? null
          : window
        : target === 'document'
          ? typeof document === 'undefined'
            ? null
            : document
          : target
    if (!owner) return
    const handle: EventListener = event => latest.current(event as E)
    owner.addEventListener(type, handle, { capture, passive, once, signal })
    return () => owner.removeEventListener(type, handle, capture)
  }, [target, type, enabled, capture, passive, once, signal])
}

export function useDocumentEvent<K extends keyof DocumentEventMap>(
  type: K,
  listener: (event: DocumentEventMap[K]) => void,
  options?: DomEventOptions
): void {
  useDOMEvent('document', type, listener, options)
}
export function useWindowEvent<K extends keyof WindowEventMap>(
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: DomEventOptions
): void {
  useDOMEvent('window', type, listener, options)
}

export interface IntersectionEventOptions extends Omit<
  IntersectionObserverInit,
  'root' | 'rootMargin'
> {
  enabled?: boolean
  /** Measure native root geometry after refs attach. */
  rootMargin?: string | ((root: Element | Document | null) => string)
  root?: IntersectionObserverInit['root'] | RefObject<Element | Document | null>
}

/** A memoized callback owns one visibility observation session after refs are attached. */
export function useIntersectionEvent(
  target: RefObject<Element | null>,
  listener: IntersectionObserverCallback,
  { enabled = true, root = null, rootMargin, threshold }: IntersectionEventOptions = {}
): void {
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined' || !target.current) return
    const owner = root && 'current' in root ? root.current : root
    if (root && !owner) return
    let active = true
    const observer = new IntersectionObserver(
      (entries, observer) => {
        if (active) listener(entries, observer)
      },
      {
        root: owner,
        rootMargin: typeof rootMargin === 'function' ? rootMargin(owner) : rootMargin,
        threshold,
      }
    )
    observer.observe(target.current)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [target, listener, enabled, root, rootMargin, threshold])
}

const layers = new Set<RefObject<HTMLElement | null>>()

function topLayer(target: Element | null) {
  let top: HTMLElement | null = null
  let focused: HTMLElement | null = null
  for (const ref of layers) {
    const node = ref.current
    if (!node?.isConnected || node.closest('[inert], [hidden]')) continue
    // Native keyboard ownership also identifies portalled child layers.
    if (target && node.contains(target) && (!focused || focused.contains(node))) focused = node
    // Children stay above their parent even when their effects mount first.
    if (!top || !node.contains(top)) top = node
  }
  return focused ?? top
}

export function useEscapeKey(
  onEscape: () => void,
  enabled = true,
  scope?: RefObject<HTMLElement | null>
) {
  const callback = useRef(onEscape)
  useEffect(() => {
    callback.current = onEscape
  }, [onEscape])

  useEffect(() => {
    if (!enabled) return
    if (scope) layers.add(scope)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const nativeDialog = document.activeElement?.closest('dialog[open]')
      if (nativeDialog && (!scope?.current || !nativeDialog.contains(scope.current))) return
      if (scope?.current?.closest('[inert], [hidden]')) return
      if (scope?.current && event.target instanceof Element) {
        const nativeDialog = event.target.closest('dialog[open]')
        if (nativeDialog && nativeDialog !== scope.current) return
      }
      const top = topLayer(event.target instanceof Element ? event.target : document.activeElement)
      if (event.defaultPrevented || isImeComposingEvent(event)) return
      if (top && top !== scope?.current) return
      event.preventDefault()
      event.stopPropagation()
      callback.current()
    }

    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      if (scope) layers.delete(scope)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [enabled, scope])
}

/** Apply an explicit UI focus request after commit, cancelling a deferred focus when replaced. */
export function useFocusRequest(
  target: RefObject<HTMLElement | null>,
  request?: string | number | object,
  {
    enabled = true,
    selectAll = false,
    preventScroll = false,
    animationFrame = false,
    selector,
    restoreFocus = false,
    restoreWithin,
  }: {
    enabled?: boolean
    selectAll?: boolean
    preventScroll?: boolean
    animationFrame?: boolean
    selector?: string
    restoreFocus?: boolean
    /** Restore only while focus remains in this descendant, or has returned to the body. */
    restoreWithin?: string
  } = {}
): void {
  useEffect(() => {
    if (!enabled) return
    const previous = restoreFocus ? document.activeElement : null
    const owner = restoreWithin ? target.current?.querySelector(restoreWithin) : null
    const focus = () => {
      const node = selector ? target.current?.querySelector<HTMLElement>(selector) : target.current
      if (!node) return
      node.focus({ preventScroll })
      const select = (node as HTMLInputElement | HTMLTextAreaElement).select
      if (selectAll && typeof select === 'function') select.call(node)
    }
    const frame = animationFrame ? window.requestAnimationFrame(focus) : undefined
    if (!animationFrame) focus()
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        (!restoreWithin ||
          document.activeElement === document.body ||
          owner?.contains(document.activeElement))
      )
        previous.focus({ preventScroll })
    }
  }, [
    target,
    request,
    enabled,
    selectAll,
    preventScroll,
    animationFrame,
    selector,
    restoreFocus,
    restoreWithin,
  ])
}

/** Scroll a native descendant only for an explicit navigation request. */
export function useScrollRequest(
  target: RefObject<HTMLElement | null>,
  selector: string,
  request: unknown,
  {
    enabled = true,
    block = 'nearest',
    inline,
    behavior,
    animationFrame = false,
    onScroll,
  }: {
    enabled?: boolean
    block?: ScrollLogicalPosition
    inline?: ScrollLogicalPosition
    behavior?: ScrollBehavior
    animationFrame?: boolean
    onScroll?(phase: 'before' | 'after', target: HTMLElement | null): void
  } = {}
): void {
  const observer = useRef(onScroll)
  useEffect(() => {
    observer.current = onScroll
  }, [onScroll])
  useEffect(() => {
    const scroll = () => {
      const node = enabled ? (target.current?.querySelector<HTMLElement>(selector) ?? null) : null
      observer.current?.('before', node)
      if (!enabled) return
      node?.scrollIntoView?.({
        block,
        ...(inline ? { inline } : {}),
        ...(behavior ? { behavior } : {}),
      })
      observer.current?.('after', node)
    }
    if (!animationFrame || !enabled) {
      scroll()
      return
    }
    const frame = window.requestAnimationFrame(scroll)
    return () => window.cancelAnimationFrame(frame)
  }, [target, selector, request, enabled, block, inline, behavior, animationFrame])
}

/** Own native modal focus, keyboard trapping and background isolation together. */
export const focusableSelector =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"]:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'

export function isFocusable(element: HTMLElement) {
  if (
    element.matches(':disabled') ||
    (element.tabIndex < 0 &&
      (!element.matches('[contenteditable="true"]') || element.hasAttribute('tabindex'))) ||
    element.closest('[hidden], [aria-hidden="true"], [inert]')
  )
    return false
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

/** Bind a native modal to its DOM node and release it when React detaches the node. */
export function useNativeDialog() {
  return useCallback((dialog: HTMLDialogElement | null) => {
    if (!dialog) return
    const previous = document.activeElement
    dialog.showModal()
    return () => {
      const ownsFocus =
        dialog.contains(document.activeElement) || document.activeElement === document.body
      dialog.close()
      if (
        ownsFocus &&
        previous instanceof HTMLElement &&
        previous.isConnected &&
        !previous.closest('[inert]')
      )
        previous.focus()
    }
  }, [])
}

export function useDialogKeyboard<T extends HTMLElement>(
  onClose: () => void,
  open = true,
  initialFocus?: string,
  trapFocus = true,
  restoreFocus?: string | (() => HTMLElement | null) | { fallbackSelector: string }
) {
  const ref = useRef<T>(null)
  const [activation, setActivation] = useState(() => ({
    open,
    opener: open && typeof document !== 'undefined' ? document.activeElement : null,
  }))
  if (activation.open !== open)
    setActivation({
      open,
      opener: open && typeof document !== 'undefined' ? document.activeElement : activation.opener,
    })
  useEscapeKey(onClose, open, ref)

  useEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return
    const previousFocus = activation.opener
    const focusContainer = dialog.closest('[role="dialog"]')
    if (!dialog.contains(document.activeElement)) {
      const preferred = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          initialFocus ??
            'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea:not([disabled]), button[type="submit"]:not([disabled])'
        )
      ).find(isFocusable)
      const target =
        initialFocus === ':scope'
          ? dialog
          : (preferred ??
            Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).find(isFocusable) ??
            dialog)
      target.focus()
    }
    const restoreBackground = isolateModalBackground(dialog, trapFocus)
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return
      const boundary = document.activeElement?.closest('[role="dialog"], dialog[open]')
      if (boundary && boundary !== dialog && !boundary.contains(dialog)) return
      const elements = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        isFocusable
      )
      const first = elements[0]
      const last = elements.at(-1)
      if (!first) {
        event.preventDefault()
        dialog.focus()
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    if (trapFocus) dialog.addEventListener('keydown', handleTab)
    return () => {
      restoreBackground?.()
      dialog.removeEventListener('keydown', handleTab)
      const restoreOpener = () => {
        const requestedTarget = typeof restoreFocus === 'function' ? restoreFocus() : null
        const returnTarget = requestedTarget?.isConnected
          ? requestedTarget
          : previousFocus instanceof HTMLElement &&
              previousFocus !== document.body &&
              previousFocus.isConnected &&
              !previousFocus.closest('[hidden], [inert]')
            ? previousFocus
            : typeof restoreFocus === 'string'
              ? focusContainer?.querySelector<HTMLElement>(restoreFocus)
              : restoreFocus && typeof restoreFocus === 'object'
                ? document.querySelector<HTMLElement>(restoreFocus.fallbackSelector)
                : null
        if (
          returnTarget &&
          (dialog.contains(document.activeElement) ||
            document.activeElement === document.body ||
            (restoreFocus && focusContainer?.contains(document.activeElement)))
        )
          returnTarget.focus()
      }
      // Nested modal owners release inert during the same cleanup pass.
      if (previousFocus instanceof HTMLElement && previousFocus.closest('[inert]'))
        queueMicrotask(restoreOpener)
      else restoreOpener()
    }
  }, [open, initialFocus, trapFocus, restoreFocus, activation.opener])

  return ref
}

/** Size native composer elements to their committed content, coalescing layout work per frame. */
export function useAutoResizeTextarea(value: string, maxHeight: number | null) {
  const textareaRef = useRef<HTMLElement>(null)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      const textarea = textareaRef.current
      if (!textarea) return
      if (maxHeight === null) {
        textarea.style.height = ''
        textarea.style.maxHeight = ''
        return
      }

      if (textarea.tagName !== 'TEXTAREA') {
        textarea.style.height = ''
        textarea.style.maxHeight = `${maxHeight}px`
        return
      }

      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
    })

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [maxHeight, value])

  return textareaRef
}

/** Restore focus after an owned control is removed, without taking focus from another action. */
export function useOwnedFocusTarget(
  scope: RefObject<HTMLElement | null>,
  selector: string | null | undefined,
  enabled = true
): void {
  const lastOwnedFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!enabled) return
    const section = scope.current
    if (!section) return
    const remember = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) lastOwnedFocus.current = event.target
    }
    const current = document.activeElement
    if (current instanceof HTMLElement && section.contains(current))
      lastOwnedFocus.current = current
    const restore = () => {
      if (selector === undefined) return
      const current = document.activeElement
      const lostOwnedControl =
        (current === document.body || current === null) &&
        lastOwnedFocus.current !== null &&
        !lastOwnedFocus.current.isConnected
      if (current !== section && !lostOwnedControl) return
      const requested = selector === null ? null : section.querySelector<HTMLElement>(selector)
      const target =
        requested && !requested.closest('[hidden], [inert]') && !requested.matches(':disabled')
          ? requested
          : section
      if (current !== target) target.focus()
    }
    section.addEventListener('focusin', remember, true)
    const observer = selector === undefined ? null : new MutationObserver(restore)
    // SDK-rendered targets can become focusable after their DOM node is attached.
    observer?.observe(section, {
      childList: true,
      subtree: true,
      attributeFilter: ['tabindex', 'disabled', 'hidden', 'inert'],
    })
    restore()
    return () => {
      observer?.disconnect()
      section.removeEventListener('focusin', remember, true)
    }
  }, [scope, selector, enabled])
}

export interface ElementGeometry {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly width: number
  readonly height: number
  readonly scrollHeight: number
}
export interface GeometrySnapshot {
  readonly elements: readonly (ElementGeometry | null)[]
  readonly viewportWidth: number
  readonly viewportHeight: number
}
const geometryProperties = [
  'left',
  'top',
  'right',
  'bottom',
  'width',
  'height',
  'scrollHeight',
] as const

function sameGeometry(first: GeometrySnapshot | null, second: GeometrySnapshot | null) {
  if (first === second) return true
  return Boolean(
    first &&
    second &&
    first.viewportWidth === second.viewportWidth &&
    first.viewportHeight === second.viewportHeight &&
    first.elements.length === second.elements.length &&
    first.elements.every((element, index) => {
      const other = second.elements[index]
      return element && other
        ? geometryProperties.every(property => element[property] === other[property])
        : element === other
    })
  )
}

/** Width-only consumers have no dependency on scrolling or subtree layout. */
export function useElementWidth<T extends HTMLElement>(enabled = true) {
  const [width, setWidth] = useState(0)
  const attach = useCallback(
    (element: T | null) => {
      if (!enabled || !element) return
      setWidth(element.getBoundingClientRect().width)
      const observer = new ResizeObserver(([entry]) => {
        setWidth(entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width)
      })
      observer.observe(element, { box: 'border-box' })
      return () => observer.disconnect()
    },
    [enabled]
  )
  return [enabled ? width : 0, attach] as const
}

function observeElementGeometry(
  nodes: readonly (HTMLElement | null)[],
  publish: (value: GeometrySnapshot) => void
) {
  let active = true
  let frame: number | null = null
  const update = () => {
    if (!active) return
    publish({
      elements: nodes.map(node => {
        if (!node) return null
        const rect = node.getBoundingClientRect()
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          scrollHeight: node.scrollHeight,
        }
      }),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    })
  }
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
  for (const node of new Set(nodes)) if (node) observer?.observe(node)
  const onScroll = (event: Event) => {
    const target = event.target
    if (
      target === window ||
      (target instanceof Node && nodes.some(node => node !== null && target.contains(node)))
    ) {
      update()
    }
  }
  window.addEventListener('resize', update)
  window.addEventListener('scroll', onScroll, true)
  return {
    nodes,
    update,
    scheduleUpdate() {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        update()
      })
    },
    stop() {
      active = false
      if (frame !== null) window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', onScroll, true)
    },
  }
}

/** Observe committed native bounds; callers derive placement without supplying setup callbacks. */
export function useElementGeometry(
  targets: readonly RefObject<HTMLElement | null>[],
  enabled = true
) {
  const [geometry, setGeometry] = useState<GeometrySnapshot | null>(null)
  const latest = useRef<GeometrySnapshot | null>(null)
  const binding = useRef<ReturnType<typeof observeElementGeometry> | null>(null)
  const publish = (next: GeometrySnapshot | null) => {
    if (sameGeometry(latest.current, next)) return
    latest.current = next
    setGeometry(next)
  }
  useLayoutEffect(() => {
    const nodes = targets.map(target => target.current)
    if (!enabled || !nodes.some(Boolean)) {
      binding.current?.stop()
      binding.current = null
      publish(null)
      return
    }
    if (
      !binding.current ||
      binding.current.nodes.length !== nodes.length ||
      binding.current.nodes.some((node, index) => node !== nodes[index])
    ) {
      binding.current?.stop()
      binding.current = observeElementGeometry(nodes, publish)
      binding.current.update()
    } else {
      // Repeated commits must not force layout between unrelated DOM writes.
      binding.current.scheduleUpdate()
    }
  })
  useLayoutEffect(
    () => () => {
      binding.current?.stop()
      binding.current = null
    },
    []
  )
  return enabled ? geometry : null
}

export interface ElementTypographySnapshot {
  readonly contentWidth: number
  readonly fontFamily: string
  readonly fontWeight: string
  readonly rootFontSize: string
  readonly properties: Readonly<Record<string, string>>
  readonly fontRevision: number
}

function observeElementTypography(
  element: HTMLElement,
  propertyNames: readonly string[],
  readFontRevision: () => number,
  advanceFontRevision: () => void,
  publish: (snapshot: ElementTypographySnapshot, fromResize?: boolean) => void
) {
  let active = true
  let snapshot: ElementTypographySnapshot | null = null
  let horizontalPadding = 0
  const root = element.ownerDocument.documentElement
  const fonts = element.ownerDocument.fonts
  const readWidth = () => Math.max(0, Math.round(element.clientWidth - horizontalPadding))
  const update = (fromResize = false, observedWidth?: number) => {
    if (!active) return
    if (observedWidth !== undefined && observedWidth === snapshot?.contentWidth) return
    const style = getComputedStyle(element)
    horizontalPadding =
      (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
    snapshot = {
      contentWidth: observedWidth ?? readWidth(),
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      rootFontSize: getComputedStyle(root).fontSize,
      properties: Object.fromEntries(
        propertyNames.map(name => [name, style.getPropertyValue(name)])
      ),
      fontRevision: readFontRevision(),
    }
    publish(snapshot, fromResize)
  }
  const resize =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(entries => {
          const entry = entries[0]
          if (entry) update(true, Math.max(0, Math.round(entry.contentRect.width)))
        })
  resize?.observe(element)
  const mutation =
    typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => update())
  const themeScope = element.closest('.collaboration-theme')
  const styleChanges = { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] }
  mutation?.observe(root, styleChanges)
  mutation?.observe(element, styleChanges)
  if (themeScope) mutation?.observe(themeScope, styleChanges)
  const fontsLoaded = () => {
    if (!active) return
    advanceFontRevision()
    // Font consumers invalidate their caches during dispatch before the new metrics publish.
    queueMicrotask(update)
  }
  fonts?.addEventListener('loadingdone', fontsLoaded)
  update()
  return {
    element,
    propertyKey: JSON.stringify(propertyNames),
    updateWidth() {
      if (!active) return
      // A shell split only changes geometry. Reuse typography unless a style
      // or font invalidation is pending in the same commit.
      if (
        !snapshot ||
        mutation?.takeRecords().length ||
        snapshot.fontRevision !== readFontRevision()
      ) {
        update()
        return
      }
      const contentWidth = readWidth()
      if (contentWidth === snapshot.contentWidth) return
      snapshot = { ...snapshot, contentWidth }
      publish(snapshot)
    },
    stop() {
      active = false
      resize?.disconnect()
      mutation?.disconnect()
      fonts?.removeEventListener('loadingdone', fontsLoaded)
    },
  }
}

/** Native content width and raw typography values; consumers own font assembly and caches. */
export function useElementTypography(
  target: RefObject<HTMLElement | null>,
  propertyNames: readonly `--${string}`[],
  enabled = true,
  layoutRevision?: string
) {
  const [snapshot, setSnapshot] = useState<ElementTypographySnapshot | null>(null)
  const latest = useRef<ElementTypographySnapshot | null>(null)
  const fontRevision = useRef(0)
  const binding = useRef<ReturnType<typeof observeElementTypography> | null>(null)
  const committedRevision = useRef(layoutRevision)
  const publish = (next: ElementTypographySnapshot | null, fromResize = false) => {
    if (JSON.stringify(latest.current) === JSON.stringify(next)) return
    const previousWidth = latest.current?.contentWidth ?? 0
    latest.current = next
    // A measured column resize must publish its geometry before the next paint.
    // Initial and typography-only observations keep the normal React update path.
    if (
      fromResize &&
      previousWidth > 0 &&
      next &&
      next.contentWidth > 0 &&
      next.contentWidth !== previousWidth
    ) {
      flushSync(() => setSnapshot(next))
    } else setSnapshot(next)
  }
  useLayoutEffect(() => {
    const element = target.current
    if (!enabled || !element) {
      binding.current?.stop()
      binding.current = null
      publish(null)
      return
    }
    if (
      binding.current?.element !== element ||
      binding.current?.propertyKey !== JSON.stringify(propertyNames)
    ) {
      binding.current?.stop()
      binding.current = observeElementTypography(
        element,
        propertyNames,
        () => fontRevision.current,
        () => {
          fontRevision.current += 1
        },
        publish
      )
    } else if (committedRevision.current !== layoutRevision) {
      // The owning layout has just committed a different split. Read its actual
      // column now so a second observer-driven commit cannot expose old geometry.
      binding.current.updateWidth()
    }
    committedRevision.current = layoutRevision
  })
  useLayoutEffect(
    () => () => {
      binding.current?.stop()
      binding.current = null
    },
    []
  )
  return enabled ? snapshot : null
}

/** Reveal a native anchor inside its unobstructed reading viewport and report actual success. */
export function useReadableScrollRequest(
  container: RefObject<HTMLElement | null>,
  selector: string,
  request: unknown,
  {
    enabled = true,
    ready = true,
    contentVersion,
    matchAttribute,
    matchValue,
    occlusionSelector,
  }: {
    enabled?: boolean
    ready?: boolean
    contentVersion?: unknown
    matchAttribute?: string
    matchValue?: string
    occlusionSelector?: string
  } = {}
): { request: unknown; locatedAt: number } | null {
  const memory = useRef<{ request: unknown; position: ReadableScrollMemory } | null>(null)
  const [receipt, setReceipt] = useState<{ request: unknown; locatedAt: number } | null>(null)
  useEffect(() => {
    if (!enabled) {
      memory.current = null
      return
    }
    const node = container.current
    if (!node) return
    if (!memory.current || memory.current.request !== request)
      memory.current = { request, position: { located: false, cancelled: false } }
    if (memory.current.position.cancelled) return
    return observeReadableScrollRequest(
      node,
      { selector, matchAttribute, matchValue, occlusionSelector, ready },
      memory.current.position,
      () => setReceipt({ request, locatedAt: Date.now() })
    )
  }, [
    container,
    selector,
    request,
    enabled,
    ready,
    contentVersion,
    matchAttribute,
    matchValue,
    occlusionSelector,
  ])
  return receipt
}

/** Bind an explicit focus request to a committed editor widget, reporting only applied commands. */
export function useEditorFocusRequest(
  target: RefObject<EditorFocusTarget | null>,
  request: unknown,
  {
    enabled = true,
    animationFrame = false,
    eligible,
    onFocused,
    activeScope,
    guardModalFocus = false,
    onlyFromBodyOrTarget = false,
  }: EditorFocusGuard & {
    enabled?: boolean
    animationFrame?: boolean
    eligible?(): boolean
    onFocused?(): void
  } = {}
): void {
  const scopeSelector = activeScope?.selector
  const scopeMatch = activeScope?.matches
  useEffect(() => {
    if (!enabled) return
    const apply = () => {
      if (eligible && !eligible()) return
      if (
        focusEditorTarget(target.current, {
          activeScope:
            scopeSelector && scopeMatch
              ? { selector: scopeSelector, matches: scopeMatch }
              : undefined,
          guardModalFocus,
          onlyFromBodyOrTarget,
        })
      )
        onFocused?.()
    }
    const frame = animationFrame ? window.requestAnimationFrame(apply) : undefined
    if (!animationFrame) apply()
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
  }, [
    target,
    request,
    enabled,
    animationFrame,
    eligible,
    onFocused,
    scopeSelector,
    scopeMatch,
    guardModalFocus,
    onlyFromBodyOrTarget,
  ])
}

/** Bind native text highlights and bounded search navigation to their actual content/scroll refs. */
export function useConversationSearchHighlights(
  {
    target,
    navigationPaused = false,
    contentRef,
    scrollRef,
    interactionRef,
    onNavigationTargetChange,
    onNavigationFailure,
  }: ConversationSearchHighlightOptions,
  id: string
) {
  const binding = useMemo(() => createConversationSearchHighlightBinding(id), [id])
  useLayoutEffect(() => {
    binding.commit(target, navigationPaused)
  }, [binding, target, navigationPaused])
  useEffect(
    () =>
      binding.observe({
        target,
        contentRef,
        scrollRef,
        interactionRef,
        onNavigationTargetChange,
        onNavigationFailure,
      }),
    [
      binding,
      target,
      contentRef,
      scrollRef,
      interactionRef,
      onNavigationTargetChange,
      onNavigationFailure,
    ]
  )
}

/** Release only the native frame probe still owned by this reader pane. */
export function useConversationFrameProbeOwner(
  readState: () => Readonly<ConversationFrameProbeState>
): void {
  useEffect(() => () => stopConversationFrameProbe(readState), [readState])
}
