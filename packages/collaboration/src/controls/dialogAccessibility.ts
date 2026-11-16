import { hideOthers } from 'aria-hidden'

/** Keep ordinary configuration panels outside the modal isolation lifecycle. */
export function hideModalBackground(dialog: HTMLElement | null, trapFocus = true) {
  if (trapFocus && dialog?.matches('[role="dialog"][aria-modal="true"]')) {
    return hideOthers(dialog)
  }
}
