import type { Terminal } from '@xterm/xterm'

type XtermMacKeybindingsOptions = {
  terminal: Pick<Terminal, 'attachCustomKeyEventHandler'>
  writeData: (data: string) => void
}

function isMacOsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return (
    (navigator.platform ?? '').startsWith('Mac') || (navigator.userAgent ?? '').includes('Mac OS X')
  )
}

function getMacKeybindingData(event: KeyboardEvent): string | null {
  if (event.altKey === event.metaKey) return null

  if (event.altKey) {
    return event.key === 'ArrowLeft' ? '\x1bb' : event.key === 'ArrowRight' ? '\x1bf' : null
  }

  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return '\x01'
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return '\x05'
  if (event.key === 'Backspace') return '\x15'
  if (event.key === 'Delete') return '\x0b'
  return null
}

export function installXtermMacKeybindings({
  terminal,
  writeData,
}: XtermMacKeybindingsOptions): void {
  if (!isMacOsPlatform()) return

  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown' || event.ctrlKey || event.shiftKey) {
      return true
    }

    const data = getMacKeybindingData(event)
    if (!data) return true

    event.preventDefault()
    event.stopPropagation()
    writeData(data)
    return false
  })
}
