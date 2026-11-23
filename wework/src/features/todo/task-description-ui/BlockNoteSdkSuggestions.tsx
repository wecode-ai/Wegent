import { useBlockNoteSdkPopupRef } from './blockNoteSdkPopupPresence'
import { SuggestionMenu, filterSuggestionItems } from '@blocknote/core/extensions'
import {
  getDefaultReactEmojiPickerItems,
  getDefaultReactSlashMenuItems,
  useBlockNoteEditor,
  useEditorDOMElement,
  useExtension,
  useExtensionState,
  useLoadSuggestionMenuItems,
} from '@blocknote/react'
import { useTranslation } from '@/hooks/useTranslation'
import { spatialMove } from '@ui-sdk/core'
import { createParts, usePart, usePrimitive } from '@ui-sdk/react/primitive'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { Popover, PopoverContent } from '@wegent/collaboration/controls/Popover'
import { controlOption } from '@wegent/collaboration/controls/recipes'
import { ProgressRing } from '@wegent/collaboration/controls/ProgressBar'
import { useCallback, useId, useState, type ReactNode } from 'react'

import { blockNoteSuggestionList } from './blockNoteSuggestionList'

const { Item: SuggestionItem } = createParts(blockNoteSuggestionList, { item: 'div' })

interface Item {
  label: string
  icon?: ReactNode
  description?: string
  group?: string
  action: () => void
}

function SuggestionResults({
  query,
  emoji,
  close,
  clear,
}: {
  query: string
  emoji: boolean
  close: () => void
  clear: () => void
}) {
  const editor = useBlockNoteEditor()
  const { t } = useTranslation('common')
  const editorElement = useEditorDOMElement()
  const id = useId()
  const [menuElement, setMenuElement] = useState<HTMLDivElement | null>(null)
  const getItems = useCallback(
    async (value: string): Promise<Item[]> => {
      if (emoji)
        return (await getDefaultReactEmojiPickerItems(editor, value)).map(item => ({
          label: item.id,
          icon: item.icon,
          action: () => item.onItemClick(),
        }))
      return filterSuggestionItems(getDefaultReactSlashMenuItems(editor), value).map(item => ({
        label: item.title,
        icon: item.icon,
        description: item.subtext,
        group: item.group,
        action: () => item.onItemClick(),
      }))
    },
    [editor, emoji]
  )
  const { items, loadingState } = useLoadSuggestionMenuItems(query, getItems)
  const choose = useCallback(
    (value: unknown) => {
      const item = typeof value === 'string' ? items[Number(value)] : undefined
      if (!item) return
      close()
      clear()
      item.action()
    },
    [clear, close, items]
  )
  const handle = usePrimitive(blockNoteSuggestionList, {
    items: items.map((item, index) => ({ value: String(index), label: item.label })),
    onChoose: choose,
  })
  const bindList = useCallback(
    (element: HTMLDivElement | null) => {
      setMenuElement(element)
      if (!editorElement || !element) return
      handle.api.list.move('first')
      const prior = new Map(
        ['aria-expanded', 'aria-controls', 'aria-activedescendant'].map(name => [
          name,
          editorElement.getAttribute(name),
        ])
      )
      editorElement.setAttribute('aria-expanded', 'true')
      editorElement.setAttribute('aria-controls', id)
      const syncActiveOption = () => {
        const activeId = handle.api.list.activeId(handle.instance.get())
        if (activeId) editorElement.setAttribute('aria-activedescendant', activeId)
        else editorElement.removeAttribute('aria-activedescendant')
      }
      syncActiveOption()
      const unsubscribe = handle.instance.subscribe(syncActiveOption)
      return () => {
        unsubscribe()
        for (const [name, value] of prior) {
          if (value === null) editorElement.removeAttribute(name)
          else editorElement.setAttribute(name, value)
        }
      }
    },
    [editorElement, handle.api, handle.instance, id, items, query]
  )

  // The editor keeps DOM focus; SDK owns option navigation and activation.
  useDOMEvent<KeyboardEvent>(
    editorElement ?? null,
    'keydown',
    event => {
      if (!menuElement) return
      if (event.isComposing || event.keyCode === 229) return
      if (
        ![
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'PageUp',
          'PageDown',
          'Home',
          'End',
          'Enter',
        ].includes(event.key)
      )
        return
      if (emoji && event.key.startsWith('Arrow')) {
        const rows = Array.from(menuElement.querySelectorAll<HTMLElement>('[data-index]')).map(
          el => ({ key: el.dataset.index ?? '', props: {}, el })
        )
        const current = handle.state.highlighted
        const from = rows.find(row => row.key === current)
        if (from) {
          const key = spatialMove()(event, { from, items: rows, rtl: menuElement.dir === 'rtl' })
          if (key !== undefined) {
            event.preventDefault()
            handle.api.list.highlight(key)
          }
          return
        }
      }
      handle.api.keydown(event)
    },
    { capture: true, enabled: Boolean(menuElement) }
  )
  return usePart(
    handle,
    'root',
    {},
    {
      id,
      ref: bindList,
      'aria-label': emoji ? ':' : '/',
      className: emoji
        ? 'grid w-[30rem] max-w-full grid-cols-[repeat(auto-fit,minmax(2.75rem,1fr))] gap-1 md:grid-cols-10'
        : 'flex flex-col',
      children: (
        <>
          {loadingState !== 'loaded' && <ProgressRing value={null} label={t('common.loading')} />}
          {items.map((item, index) => (
            <SuggestionItem
              key={`${index}-${item.label}`}
              value={String(index)}
              label={item.label}
              data-index={index}
              data-testid={`task-description-${emoji ? 'emoji' : 'slash'}-item-${index}`}
              className={`${controlOption} ${emoji ? 'justify-center p-1' : 'gap-2'}`}
            >
              {item.icon}
              {!emoji && (
                <span className="min-w-0 flex-1">
                  <span className="block">{item.label}</span>
                  <span className="block text-xs text-text-muted">{item.description}</span>
                </span>
              )}
            </SuggestionItem>
          ))}
          {!items.length && loadingState === 'loaded' && (
            <div className="p-2 text-sm text-text-muted">
              {editor.dictionary.suggestion_menu.no_items_title}
            </div>
          )}
        </>
      ),
    }
  )
}

export function BlockNoteSdkSuggestions({ emoji = false }: { emoji?: boolean }) {
  const editor = useBlockNoteEditor()
  const extension = useExtension(SuggestionMenu)
  const state = useExtensionState(SuggestionMenu)
  const triggerCharacter = emoji ? ':' : '/'
  const bindExtension = useCallback(
    (node: HTMLSpanElement | null) => {
      if (!node) return
      extension.addSuggestionMenu({
        triggerCharacter,
        shouldOpen: emoji
          ? undefined
          : state => !state.selection.$from.parent.type.isInGroup('tableContent'),
      })
      return () => extension.removeSuggestionMenu(triggerCharacter)
    },
    [emoji, extension, triggerCharacter]
  )
  const eligible =
    state?.show &&
    state.triggerCharacter === triggerCharacter &&
    (!emoji || state.ignoreQueryLength || (!state.query.startsWith(' ') && state.query.length >= 2))
  const popupRef = useBlockNoteSdkPopupRef()
  const anchor = {
    contextElement: editor.domElement?.firstElementChild ?? undefined,
    getBoundingClientRect: () => state?.referencePos ?? new DOMRect(),
  }
  return (
    <>
      <span hidden ref={bindExtension} />
      <Popover
        open={Boolean(eligible)}
        onOpenChange={open => {
          if (!open) extension.closeMenu()
        }}
      >
        <PopoverContent
          ref={popupRef}
          container={editor.portalElement}
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={10}
          initialFocus="none"
          finalFocus="none"
          onMouseDownCapture={event => event.preventDefault()}
          className="max-h-80 w-max max-w-[calc(100vw-1rem)] overflow-y-auto p-1"
          data-testid={`task-description-${emoji ? 'emoji' : 'slash'}-menu`}
          aria-label={triggerCharacter}
        >
          {eligible && state && (
            <SuggestionResults
              query={state.query}
              emoji={emoji}
              close={extension.closeMenu}
              clear={extension.clearQuery}
            />
          )}
        </PopoverContent>
      </Popover>
    </>
  )
}
