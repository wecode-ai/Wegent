import { createListbox, definePrimitive } from '@ui-sdk/core'

interface SuggestionListOptions {
  items: { value: string; label: string }[]
  onChoose: (value: string) => void
}

// The professional editor owns the input; SDK owns the virtual-focus options.
export const blockNoteSuggestionList = definePrimitive({
  name: 'block-note-suggestions',
  options: { items: 'value', onChoose: 'callback' },
  state: (): { highlighted: string | null } => ({
    highlighted: null,
  }),
  api: (
    context: import('@ui-sdk/core').PrimitiveContext<
      SuggestionListOptions,
      { highlighted: string | null },
      string
    >
  ) => {
    const list = createListbox(context, {
      key: 'highlighted',
      focus: 'virtual',
      items: () => context.options().items,
    })
    return {
      list,
      choose: (value: string) => context.options().onChoose(value),
      keydown: (event: KeyboardEvent) => {
        if (event.isComposing || event.keyCode === 229) return
        list.keydown(event)
        if (event.key === 'Enter') {
          const value = context.store.get().highlighted
          if (value !== null) {
            event.preventDefault()
            event.stopPropagation()
            context.options().onChoose(value)
          }
        }
      },
    }
  },
  slots: slot => ({
    root: slot({
      role: 'listbox',
      keys: { none: 'The contenteditable input forwards SDK keyboard navigation' },
    }),
    item: slot<{ value: string; label: string }>({
      role: 'option',
      focus: 'active-descendant',
      props: { value: 'string', label: 'string' },
      attrs: (state, part) => ({
        ...part.api.list.attrs(state, part),
        'aria-selected': String(state.highlighted === part.key),
      }),
      bind: (el, part) => part.api.list.bind(el, part),
      press: ({ key, api }) => api.choose(key),
      on: { pointermove: (event, { key, api }) => api.list.highlight(key, { event }) },
    }),
  }),
})
