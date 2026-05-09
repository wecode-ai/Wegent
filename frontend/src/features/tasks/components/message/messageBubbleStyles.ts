// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface MessageBubbleClassNames {
  baseClasses: string
  typeClasses: string
}

/**
 * User bubbles should stay visually compact for short prompts, while AI bubbles
 * keep the roomier reading rhythm needed for long-form content and toolbars.
 */
export function getMessageBubbleClassNames(isUserTypeMessage: boolean): MessageBubbleClassNames {
  if (isUserTypeMessage) {
    return {
      baseClasses: 'relative max-w-full overflow-visible px-4 py-3 text-text-primary',
      typeClasses: 'group rounded-2xl border border-border bg-surface shadow-sm',
    }
  }

  return {
    baseClasses: 'relative w-full px-5 pt-5 pb-10 text-text-primary',
    typeClasses: '',
  }
}
