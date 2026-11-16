import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import { createDesktopControlFile } from './file-fixture'

/** Exercise the real file input change flow without an OS-specific picker. */
export function selectDesktopControlFile(
  element: Element | undefined,
  command: DesktopControlCommand
): string {
  if (!(element instanceof HTMLInputElement) || element.type !== 'file')
    throw new Error('selectFile requires a file input')
  const file = createDesktopControlFile(command)
  const transfer = new DataTransfer()
  transfer.items.add(file)
  element.files = transfer.files
  element.dispatchEvent(new Event('change', { bubbles: true }))
  return file.name
}
