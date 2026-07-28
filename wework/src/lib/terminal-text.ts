const MAX_TERMINAL_ROWS = 200
const MAX_TERMINAL_COLUMNS = 4_096
const MAX_RENDERED_CELLS = 32_768

function parameterValue(parameters: string, fallback: number): number {
  const value = Number.parseInt(parameters.split(';')[0] ?? '', 10)
  return Number.isFinite(value) ? value : fallback
}

/** Convert terminal-oriented output into a bounded plain-text scrollback snapshot. */
export function terminalOutputToText(value: string): string {
  const lines = ['']
  let row = 0
  let column = 0
  let renderedCells = 0

  const moveToRow = (nextRow: number, preserveColumn = false) => {
    const previousColumn = column
    row = Math.max(0, Math.min(nextRow, MAX_TERMINAL_ROWS - 1))
    while (lines.length <= row) lines.push('')
    column = preserveColumn
      ? Math.min(previousColumn, MAX_TERMINAL_COLUMNS)
      : Math.min(column, lines[row].length)
  }

  const replaceLine = (nextLine: string) => {
    renderedCells += nextLine.length - lines[row].length
    lines[row] = nextLine
  }

  const writeText = (text: string) => {
    if (!text || column >= MAX_TERMINAL_COLUMNS) return

    const line = lines[row]
    const availableCells = MAX_RENDERED_CELLS - renderedCells
    const maxEnd = Math.min(MAX_TERMINAL_COLUMNS, line.length + availableCells)
    const writableLength = Math.min(text.length, MAX_TERMINAL_COLUMNS - column, maxEnd - column)
    if (writableLength <= 0) return

    const nextColumn = column + writableLength
    const prefix = line.slice(0, column).padEnd(column, ' ')
    const suffix = line.slice(nextColumn)
    replaceLine(prefix + text.slice(0, writableLength) + suffix)
    column = nextColumn
  }

  const lineFeed = () => {
    if (row < MAX_TERMINAL_ROWS - 1) {
      moveToRow(row + 1)
    } else {
      const removedLine = lines.shift()
      renderedCells -= removedLine?.length ?? 0
      lines.push('')
    }
    column = 0
  }

  const eraseInLine = (parameters: string) => {
    const mode = parameterValue(parameters, 0)
    const line = lines[row]
    if (mode === 0) {
      replaceLine(line.slice(0, column))
    } else if (mode === 1) {
      const targetLength = Math.min(column + 1, MAX_TERMINAL_COLUMNS)
      const availableCells = MAX_RENDERED_CELLS - renderedCells
      const eraseEnd = Math.min(targetLength, line.length + availableCells)
      replaceLine(' '.repeat(eraseEnd) + line.slice(eraseEnd))
    } else if (mode === 2) {
      replaceLine('')
    }
  }

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]

    if (character === '\n') {
      lineFeed()
      continue
    }
    if (character === '\r') {
      column = 0
      continue
    }
    if (character === '\b') {
      column = Math.max(0, column - 1)
      continue
    }
    if (character === '\t') {
      writeText(' '.repeat(8 - (column % 8)))
      continue
    }
    if (character !== '\u001b') {
      if (character >= ' ') {
        let end = index + 1
        while (end < value.length && value[end] >= ' ' && value[end] !== '\u001b') end += 1
        writeText(value.slice(index, Math.min(end, index + MAX_TERMINAL_COLUMNS)))
        index = end - 1
      }
      continue
    }

    if (value[index + 1] === ']') {
      const bellEnd = value.indexOf('\u0007', index + 2)
      const stringEnd = value.indexOf('\u001b\\', index + 2)
      const end =
        bellEnd === -1 ? stringEnd : stringEnd === -1 ? bellEnd : Math.min(bellEnd, stringEnd)
      if (end === -1) break
      index = end + (value[end] === '\u001b' ? 1 : 0)
      continue
    }

    if (value[index + 1] !== '[') {
      index += 1
      continue
    }

    let finalIndex = index + 2
    while (finalIndex < value.length && !/[\x40-\x7e]/.test(value[finalIndex])) {
      finalIndex += 1
    }
    if (finalIndex >= value.length) break

    const parameters = value.slice(index + 2, Math.min(finalIndex, index + 66))
    const command = value[finalIndex]
    const amount = parameterValue(parameters, 1)
    if (command === 'A') moveToRow(row - amount, true)
    else if (command === 'B') moveToRow(row + amount, true)
    else if (command === 'G' || command === '`')
      column = Math.max(0, Math.min(amount - 1, MAX_TERMINAL_COLUMNS - 1))
    else if (command === 'C') column = Math.min(column + amount, MAX_TERMINAL_COLUMNS - 1)
    else if (command === 'D') column = Math.max(0, column - amount)
    else if (command === 'K') eraseInLine(parameters)
    index = finalIndex
  }

  return lines.map(line => line.trimEnd()).join('\n')
}
