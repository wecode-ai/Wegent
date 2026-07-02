import type { Terminal } from '@xterm/xterm'

type XtermInputFallbackOptions = {
  terminal: Pick<Terminal, 'textarea'>
  writeData: (data: string) => void
}

export type XtermInputFallbackController = {
  noteData: (data: string) => void
  dispose: () => void
}

function longestPrefixCoveredBySuffix(input: string, emitted: string): number {
  const maxLength = Math.min(input.length, emitted.length)
  for (let length = maxLength; length > 0; length -= 1) {
    if (emitted.endsWith(input.slice(0, length))) {
      return length
    }
  }
  return 0
}

export function installXtermInputFallback({
  terminal,
  writeData,
}: XtermInputFallbackOptions): XtermInputFallbackController {
  const textarea = terminal.textarea
  if (!textarea) {
    return {
      noteData: () => undefined,
      dispose: () => undefined,
    }
  }

  let emittedSinceLastInput = ''
  const noteData = (data: string) => {
    emittedSinceLastInput = `${emittedSinceLastInput}${data}`.slice(-512)
  }

  const handleInput = (event: InputEvent) => {
    if (event.inputType !== 'insertText' || !event.data) {
      emittedSinceLastInput = ''
      return
    }

    const coveredLength = longestPrefixCoveredBySuffix(event.data, emittedSinceLastInput)
    const missingInput = event.data.slice(coveredLength)
    emittedSinceLastInput = ''

    if (missingInput) {
      writeData(missingInput)
    }
  }

  textarea.addEventListener('input', handleInput)

  return {
    noteData,
    dispose: () => textarea.removeEventListener('input', handleInput),
  }
}
