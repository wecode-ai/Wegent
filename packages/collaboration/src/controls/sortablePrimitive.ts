import {
  createChange,
  createFocusRecovery,
  createReorder,
  definePrimitive,
  elements,
  reorderMessage,
  type ChangeDetails,
  type ReorderDraft,
  type ReorderMessage,
  type ReorderOrientation,
  type ReorderReason,
} from '@ui-sdk/core'

export type SortableChangeDetails = ChangeDetails<ReorderReason> & {
  key: string
  fromIndex: number
  toIndex: number
}
interface SortableOptions {
  value?: string[]
  defaultValue?: string[]
  onValueChange?(value: string[], details: SortableChangeDetails): void
  onMoveStart?(key: string, event?: Event): void
  onMoveEnd?(key: string, committed: boolean, event?: Event): void
  orientation?: ReorderOrientation
  autoScroll?: boolean
  canStartPointer?(event: PointerEvent, key: string): boolean
  message?(message: ReorderMessage): string
}
interface SortableState {
  value: string[]
  moving: ReorderDraft | null
  orientation: ReorderOrientation
}
interface ItemProps {
  value: string
  disabled?: boolean
  label?: string
}

export const sortablePrimitive = definePrimitive({
  name: 'sortable',
  options: {
    value: 'list',
    defaultValue: 'list',
    onValueChange: 'callback',
    onMoveStart: 'callback',
    onMoveEnd: 'callback',
    orientation: 'string',
    autoScroll: 'boolean',
    canStartPointer: 'action',
    message: 'value',
  },
  controlled: ['value'],
  state: (options: SortableOptions) => ({
    value: options.value ?? options.defaultValue ?? [],
    moving: null as ReorderDraft | null,
    orientation: options.orientation ?? 'vertical',
  }),
  sync: options => ({
    ...(options.value === undefined ? {} : { value: options.value }),
    orientation: options.orientation ?? 'vertical',
  }),
  api: context => {
    const change = createChange(context)
    let initiator: Event | undefined
    let imperativeKey: string | undefined
    let activeKey: string | undefined
    let committed = false
    let endEvent: Event | undefined
    const reorder = createReorder<SortableState, ItemProps>(context, {
      slot: 'item',
      key: 'value',
      draft: 'moving',
      set: (value, details) => {
        const state = context.store.get()
        const key = state.moving?.key ?? imperativeKey
        if (!key) return false
        const accepted = change('value', value, {
          ...details,
          key,
          fromIndex: state.value.indexOf(key),
          toIndex: value.indexOf(key),
        })
        committed = accepted
        endEvent = details.event
        return accepted
      },
      orientation: () => context.options().orientation ?? 'vertical',
      disabled: item => Boolean(item.props.disabled),
      preview: true,
      createAutoScroll: context.options().autoScroll === false ? false : undefined,
      label: key => context.props<ItemProps>('item', key)?.label,
      message: message => context.options().message?.(message) ?? reorderMessage(message),
    })
    const unsubscribe = context.store.subscribe(() => {
      const next = context.store.get().moving?.key
      if (next === activeKey) return
      const previous = activeKey
      activeKey = next
      if (next) {
        committed = false
        endEvent = undefined
        context.options().onMoveStart?.(next, initiator)
      } else if (previous) {
        context.options().onMoveEnd?.(previous, committed, endEvent)
      }
    })
    context.onDestroy(() => {
      unsubscribe()
      const previous = activeKey
      activeKey = undefined
      if (previous) context.options().onMoveEnd?.(previous, false)
    })
    context.onOptions(options => {
      const state = context.store.get()
      if (!state.moving || options.value === undefined) return
      const same = (a: string[], b: string[]) =>
        a.length === b.length && a.every((id, index) => id === b[index])
      if (!same(options.value, state.value) && !same(options.value, state.moving.order))
        reorder.cancel()
    })
    const recovery = createFocusRecovery<{ value?: string }>({
      fallback: lost =>
        elements<ItemProps>(context, 'handle').find(part => part.key !== lost.key)?.el,
    })
    return {
      reorder,
      recovery,
      allItems: () =>
        context.store
          .get()
          .value.map(value => ({
            value,
            label: context.props<ItemProps>('item', value)?.label ?? value,
            disabled: Boolean(context.props<ItemProps>('item', value)?.disabled),
          })),
      move: (key: string, index: number) => {
        imperativeKey = key
        try {
          return reorder.move(key, index)
        } finally {
          imperativeKey = undefined
        }
      },
      grab: (key: string, event?: Event) => {
        initiator = event
        return reorder.grab(key)
      },
      drop: (event?: Event) => {
        endEvent = event
        reorder.drop(event)
      },
      cancel: reorder.cancel,
      pointerdown: (event: PointerEvent, key: string, area = false) => {
        if (area && context.options().canStartPointer?.(event, key) === false) return
        initiator = event
        reorder.pointerdown(event, key)
      },
      keydown: (event: KeyboardEvent, key: string) => {
        initiator = event
        endEvent = event
        return reorder.keydown(event, key)
      },
    }
  },
  slots: slot => ({
    root: slot<Record<never, never>, SortableState>({
      role: 'list',
      state: state => ({ ...state }),
    }),
    item: slot<ItemProps>({
      props: { value: 'string', disabled: 'boolean', label: 'string' },
      role: 'listitem',
      attrs: (state, part) => ({
        'data-grabbed': state.moving?.key === part.key ? '' : undefined,
        'data-dragging': state.moving?.key === part.key && state.moving.pointer ? '' : undefined,
        'data-disabled': part.props.disabled ? '' : undefined,
      }),
      bind: (el, part) => part.api.reorder.bind(el, part),
    }),
    'drag-area': slot<Omit<ItemProps, 'value'> & { value?: string }>({
      props: {
        value: { kind: 'string', from: 'item', required: true },
        disabled: { kind: 'boolean', from: 'item' },
        label: { kind: 'string', from: 'item' },
      },
      on: {
        pointerdown: (event, { api, key, props }) => {
          if (!props.disabled) api.pointerdown(event, key, true)
        },
      },
    }),
    handle: slot<Omit<ItemProps, 'value'> & { value?: string }>({
      props: {
        value: { kind: 'string', from: 'item', required: true },
        disabled: { kind: 'boolean', from: 'item' },
        label: { kind: 'string', from: 'item' },
      },
      role: 'button',
      focus: 'native',
      attrs: (state, part) => ({
        type: 'button',
        'aria-label': part.props.label,
        'aria-disabled': part.props.disabled ? 'true' : undefined,
        'aria-pressed': String(state.moving?.key === part.key),
      }),
      press: ({ api, key, props }, event) => {
        if (props.disabled || (event instanceof MouseEvent && event.detail > 0)) return
        if (!api.grab(key, event)) api.drop(event)
      },
      on: {
        keydown: (event, { api, key, props }) => {
          if (!props.disabled || event.key === 'Escape' || event.key === 'Tab')
            api.keydown(event, key)
        },
        pointerdown: (event, { api, key, props }) => {
          if (!props.disabled) api.pointerdown(event, key)
        },
      },
      bind: (el, part) => part.api.recovery.bind(el, part),
    }),
  }),
  agent: { actions: ['move', 'grab', 'drop', 'cancel'], items: api => api.allItems() },
})
