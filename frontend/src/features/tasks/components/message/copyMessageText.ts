// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

export async function copyMessageText(text: string, trigger: HTMLButtonElement): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // The legacy copy command can still be available when clipboard access is denied.
  }
  if (!trigger.isConnected) return false

  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.tabIndex = -1
  field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'
  // Keep the selection inside the dialog's focus trap, if there is one.
  const container = trigger.closest('[role="dialog"]') ?? document.body
  container.appendChild(field)
  try {
    field.focus({ preventScroll: true })
    field.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    field.remove()
    if (trigger.isConnected) trigger.focus({ preventScroll: true })
  }
}
