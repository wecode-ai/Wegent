function parameterValue(parameters: string, fallback: number): number {
  const value = Number.parseInt(parameters.split(';')[0] ?? '', 10)
  return Number.isFinite(value) ? value : fallback
}

/** Convert terminal-oriented output into stable plain text for non-terminal views. */
export function terminalOutputToText(value: string): string {
  const lines: string[][] = [[]]
  let row = 0
  let column = 0

  const currentLine = () => lines[row]
  const moveToRow = (nextRow: number) => {
    row = Math.max(0, nextRow)
    while (lines.length <= row) lines.push([])
    column = Math.min(column, currentLine().length)
  }

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]

    if (character === '\n') {
      moveToRow(row + 1)
      column = 0
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
    if (character !== '\u001b') {
      if (character >= ' ' || character === '\t') {
        const line = currentLine()
        while (line.length < column) line.push(' ')
        line[column] = character
        column += 1
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

    const parameters = value.slice(index + 2, finalIndex)
    const command = value[finalIndex]
    const amount = parameterValue(parameters, 1)
    if (command === 'G' || command === '`') column = Math.max(0, amount - 1)
    else if (command === 'C') column += amount
    else if (command === 'D') column = Math.max(0, column - amount)
    else if (command === 'K') {
      const mode = parameterValue(parameters, 0)
      const line = currentLine()
      if (mode === 0) line.splice(column)
      else if (mode === 1)
        line.splice(0, Math.min(column + 1, line.length), ...Array(column + 1).fill(' '))
      else if (mode === 2) line.length = 0
    }
    index = finalIndex
  }

  return lines.map(line => line.join('').trimEnd()).join('\n')
}
