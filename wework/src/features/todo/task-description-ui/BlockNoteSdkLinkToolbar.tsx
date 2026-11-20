import { useBlockNoteSdkPopupRef } from './blockNoteSdkPopupPresence'
import { LinkToolbarExtension } from '@blocknote/core/extensions'
import {
  LinkToolbar,
  useBlockNoteEditor,
  useEditorDOMElement,
  useExtension,
} from '@blocknote/react'
import { hoverCard } from '@ui-sdk/core/hover-card'
import { usePart, usePrimitive } from '@ui-sdk/react/primitive'
import { HoverCardContent } from '@wegent/collaboration/controls/HoverCard'
import { useCallback, useRef, useState } from 'react'

type Link = {
  url: string
  text: string
  range: { from: number; to: number }
  element: HTMLAnchorElement
}

export function BlockNoteSdkLinkToolbar() {
  const editor = useBlockNoteEditor()
  const element = useEditorDOMElement()
  const extension = useExtension(LinkToolbarExtension)
  const [link, setLink] = useState<Link>()
  const [selectionOpen, setSelectionOpen] = useState(false)
  const [open, setOpen] = useState(false)
  const [frozen, setFrozen] = useState(false)
  const frozenRef = useRef(false)
  const popupRef = useBlockNoteSdkPopupRef()
  const freeze = (value: boolean) => {
    frozenRef.current = value
    setFrozen(value)
  }
  const handle = usePrimitive(hoverCard, {
    open,
    delay: 250,
    closeDelay: 250,
    onOpenChange: (next, details) => {
      if (frozenRef.current || (selectionOpen && details.reason === 'trigger-hover')) {
        details.cancel()
        return
      }
      if (!next && details.reason === 'escape-key') editor.focus()
      setOpen(next)
    },
  })
  const bindSelection = useCallback(
    (node: HTMLSpanElement | null) => {
      if (!node) return
      const update = () => {
        if (frozenRef.current) return
        const selected = extension.getLinkAtSelection()
        const anchor = selected && extension.getLinkElementAtPos(selected.range.from)
        setSelectionOpen(Boolean(selected && anchor))
        setOpen(Boolean(selected && anchor))
        setLink(
          selected && anchor
            ? {
                url: selected.mark.attrs.href,
                text: selected.text,
                range: selected.range,
                element: anchor,
              }
            : undefined
        )
      }
      const offChange = editor.onChange(update)
      const offSelection = editor.onSelectionChange(update)
      return () => {
        offChange()
        offSelection()
      }
    },
    [editor, extension, frozen]
  )
  const bindAnchors = useCallback(
    (node: HTMLSpanElement | null) => {
      if (!node || !element || selectionOpen || frozen) return
      const bindings = new Map<HTMLAnchorElement, () => void>()
      let nextId = 0
      const refresh = () => {
        for (const [anchor, cleanup] of bindings)
          if (!element.contains(anchor)) {
            cleanup()
            bindings.delete(anchor)
          }
        for (const anchor of element.querySelectorAll('a')) {
          if (bindings.has(anchor)) continue
          const part = handle.instance.part('trigger', {
            id: `${handle.instance.id}-link-${nextId++}`,
          })
          part.el = anchor
          const slot = hoverCard.slots.trigger
          const unbind = slot.bind?.(anchor, part)
          const original = new Map<string, string | null>()
          const attrs = () => {
            for (const [name, value] of Object.entries(
              slot.attrs?.(handle.instance.get(), part) ?? {}
            )) {
              if (!original.has(name)) original.set(name, anchor.getAttribute(name))
              if (value === undefined || value === null) anchor.removeAttribute(name)
              else anchor.setAttribute(name, String(value))
            }
          }
          attrs()
          const offAttrs = handle.instance.subscribe(attrs)
          const enter = (event: PointerEvent) => {
            const hovered = extension.getLinkAtElement(anchor)
            if (hovered)
              setLink({
                url: hovered.mark.attrs.href,
                text: hovered.text,
                range: hovered.range,
                element: anchor,
              })
            slot.on?.pointerenter?.(event, part)
          }
          const leave = (event: PointerEvent) => slot.on?.pointerleave?.(event, part)
          const focus = (event: FocusEvent) => slot.on?.focusin?.(event, part)
          const blur = (event: FocusEvent) => slot.on?.focusout?.(event, part)
          const keydown = (event: KeyboardEvent) => slot.on?.keydown?.(event, part)
          anchor.addEventListener('pointerenter', enter)
          anchor.addEventListener('pointerleave', leave)
          anchor.addEventListener('focusin', focus)
          anchor.addEventListener('focusout', blur)
          anchor.addEventListener('keydown', keydown)
          bindings.set(anchor, () => {
            offAttrs()
            unbind?.()
            anchor.removeEventListener('pointerenter', enter)
            anchor.removeEventListener('pointerleave', leave)
            anchor.removeEventListener('focusin', focus)
            anchor.removeEventListener('focusout', blur)
            anchor.removeEventListener('keydown', keydown)
            for (const [name, value] of original) {
              if (value === null) anchor.removeAttribute(name)
              else anchor.setAttribute(name, value)
            }
          })
        }
      }
      // Bind public SDK trigger slots to editor-owned anchors without replacing DOM.
      refresh()
      const observer = new MutationObserver(refresh)
      observer.observe(element, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        for (const cleanup of bindings.values()) cleanup()
      }
    },
    [element, extension, frozen, handle.instance, selectionOpen]
  )
  // Share this SDK instance with its content; anchors above own the trigger DOM.
  const content = usePart(
    handle,
    'trigger',
    {},
    {
      render: () => (
        <HoverCardContent
          ref={popupRef}
          container={editor.portalElement}
          anchor={link?.element}
          side="top"
          align="start"
          sideOffset={10}
          aria-label={editor.dictionary.link_toolbar.edit.tooltip}
          data-testid="task-description-link-toolbar"
          className="w-max p-1"
        >
          {link && (
            <LinkToolbar
              url={link.url}
              text={link.text}
              range={link.range}
              setToolbarOpen={setOpen}
              setToolbarPositionFrozen={freeze}
            />
          )}
        </HoverCardContent>
      ),
    }
  )
  return (
    <>
      <span hidden ref={bindSelection} />
      <span hidden ref={bindAnchors} />
      {content}
    </>
  )
}
