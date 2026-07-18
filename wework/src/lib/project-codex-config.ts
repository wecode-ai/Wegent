export const MISSING_WORKSPACE_FILE_REVISION = 'missing'

const PLUGIN_HEADER_PATTERN = /^\s*\[plugins\."((?:[^"\\]|\\.)+)"\]\s*$/
const ENABLED_PATTERN = /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/

interface PluginBlock {
  key: string
  start: number
  end: number
  enabledLine: number | null
}

function pluginBlocks(lines: string[]): PluginBlock[] {
  const blocks: PluginBlock[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(PLUGIN_HEADER_PATTERN)
    if (!match) continue
    const nextHeader = lines.findIndex(
      (line, candidate) => candidate > index && /^\s*\[/.test(line)
    )
    const end = nextHeader === -1 ? lines.length : nextHeader
    let enabledLine: number | null = null
    for (let candidate = index + 1; candidate < end; candidate += 1) {
      if (ENABLED_PATTERN.test(lines[candidate])) {
        enabledLine = candidate
        break
      }
    }
    blocks.push({ key: match[1].replaceAll('\\"', '"'), start: index, end, enabledLine })
  }
  return blocks
}

export function enabledProjectPluginKeys(content: string): Set<string> {
  const lines = content.split('\n')
  return new Set(
    pluginBlocks(lines)
      .filter(block =>
        block.enabledLine == null
          ? false
          : ENABLED_PATTERN.exec(lines[block.enabledLine])?.[1] === 'true'
      )
      .map(block => block.key)
  )
}

export function setProjectPluginEnabled(
  content: string,
  pluginKey: string,
  enabled: boolean
): string {
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const block = pluginBlocks(lines).find(candidate => candidate.key === pluginKey)
  if (block) {
    if (!enabled) {
      lines.splice(block.start, block.end - block.start)
      while (lines.length > 1 && lines.at(-1) === '' && lines.at(-2) === '') lines.pop()
      return lines.join('\n')
    }
    if (block.enabledLine != null) lines[block.enabledLine] = 'enabled = true'
    else lines.splice(block.start + 1, 0, 'enabled = true')
    return lines.join('\n')
  }
  if (!enabled) return normalized
  const prefix = normalized.trimEnd()
  const escapedKey = pluginKey.replaceAll('"', '\\"')
  return `${prefix}${prefix ? '\n\n' : ''}[plugins."${escapedKey}"]\nenabled = true\n`
}
