import {
  createTransfer,
  createFocusRecovery,
  definePrimitive,
  type TransferDraft,
  type TransferLists,
  type TransferOptions,
} from '@ui-sdk/core'

type Commit = Parameters<TransferOptions<BoardTransferState>['set']>[1]
interface BoardTransferState {
  lists: TransferLists
  moving: TransferDraft | null
}
interface Options {
  lists: TransferLists
  onCommit(lists: TransferLists, details: Commit): boolean
  recover(itemId: string): HTMLElement | undefined
  onStart(key: string): void
  onCancel(): void
}

export const boardTransferPrimitive = definePrimitive({
  name: 'issue-board-transfer',
  options: {
    lists: 'value',
    onCommit: 'callback',
    onStart: 'callback',
    recover: 'action',
    onCancel: 'callback',
  },
  state: (options: Options): BoardTransferState => ({
    lists: options.lists,
    moving: null,
  }),
  sync: (options) => ({ lists: options.lists }),
  api: (context) => {
    let committed = false
    let last: TransferDraft | null = null
    const transfer = createTransfer(context, {
      key: 'lists',
      draft: 'moving',
      set: (lists, details) => {
        committed = context.options().onCommit(lists, details)
        return committed
      },
    })
    context.onDestroy(
      context.store.subscribe(() => {
        const moving = context.store.get().moving
        if (moving && !last) context.options().onStart(moving.key)
        if (!moving && last) {
          if (!committed) context.options().onCancel()
          committed = false
        }
        last = moving
      }),
    )
    const recovery = createFocusRecovery<{ itemId: string }>({
      fallback: (lost) => context.options().recover(lost.props.itemId),
    })
    return { transfer, recovery }
  },
  slots: (slot) => ({
    root: slot<Record<never, never>, BoardTransferState>({
      state: (state) => ({ ...state }),
    }),
  }),
})
