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
  readLists(): TransferLists
  onCommit(lists: TransferLists, details: Commit): boolean
  recover(itemId: string): HTMLElement | undefined
  onStart(draft: TransferDraft): void
  onCancel(): void
}

export const boardTransferPrimitive = definePrimitive({
  name: 'issue-board-transfer',
  options: {
    readLists: 'callback',
    onCommit: 'callback',
    onStart: 'callback',
    recover: 'action',
    onCancel: 'callback',
  },
  state: (options: Options): BoardTransferState => ({
    lists: options.readLists(),
    moving: null,
  }),
  sync: options => ({ lists: options.readLists() }),
  api: context => {
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
        if (moving && !last) context.options().onStart(moving)
        if (!moving && last) {
          if (!committed) context.options().onCancel()
          committed = false
        }
        last = moving
      })
    )
    const recovery = createFocusRecovery<{ itemId: string }>({
      fallback: lost => context.options().recover(lost.props.itemId),
    })
    const prepareMove = () => {
      // Keyed cards keep their refs when React changes their displayed order.
      if (!context.store.get().moving) context.store.set({ lists: context.options().readLists() })
    }
    return { transfer, recovery, prepareMove }
  },
  slots: slot => ({
    root: slot<Record<never, never>, BoardTransferState>({
      state: state => ({ ...state }),
    }),
  }),
})
