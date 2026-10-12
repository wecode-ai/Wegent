import type { Event, Input } from 'electron'

export function handlePopoutWindowInput(
  event: Pick<Event, 'preventDefault'>,
  input: Pick<Input, 'type' | 'key' | 'isComposing' | 'alt' | 'control' | 'meta' | 'shift'>,
  dismiss: () => void
) {
  if (
    input.type !== 'keyDown' ||
    input.key !== 'Escape' ||
    input.isComposing ||
    input.alt ||
    input.control ||
    input.meta ||
    input.shift
  )
    return
  event.preventDefault()
  dismiss()
}
