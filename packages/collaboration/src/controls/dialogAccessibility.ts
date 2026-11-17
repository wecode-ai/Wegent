import { inertOthers } from 'aria-hidden'

/** Keep ordinary configuration panels outside the modal isolation lifecycle. */
export function isolateModalBackground(dialog: HTMLElement | null, trapFocus = true) {
  if (trapFocus && dialog?.matches('[role="dialog"][aria-modal="true"]')) {
    // hideOthers exempts live regions and drops explicit aria-hidden="false" values.
    return inertOthers(dialog)
  }
}
