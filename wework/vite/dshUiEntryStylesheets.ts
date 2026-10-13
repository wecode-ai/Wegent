import path from 'node:path'

export interface DshUiOutput {
  type: 'asset' | 'chunk'
  code?: string
  exports?: string[]
  fileName: string
  imports?: string[]
  isEntry?: boolean
  name?: string
  viteMetadata?: { importedCss: Set<string> }
}

export function attachDshUiEntryStylesheets(bundle: Record<string, DshUiOutput>): void {
  for (const entry of Object.values(bundle)) {
    if (entry.type !== 'chunk' || !entry.isEntry || !entry.name?.startsWith('wework-ui-')) continue
    if (!entry.exports?.includes('default')) {
      throw new Error(`DSH UI entry "${entry.name}" must preserve its default export`)
    }
    const stylesheets = new Set<string>()
    const visited = new Set<string>()
    const visit = (chunk: DshUiOutput) => {
      if (visited.has(chunk.fileName)) return
      visited.add(chunk.fileName)
      for (const dependency of chunk.imports ?? []) {
        const imported = bundle[dependency]
        if (imported?.type === 'chunk') visit(imported)
      }
      for (const stylesheet of chunk.viteMetadata?.importedCss ?? []) stylesheets.add(stylesheet)
    }
    visit(entry)
    const urls = [...stylesheets].map(stylesheet => {
      const relative = path.posix.relative(path.posix.dirname(entry.fileName), stylesheet)
      return `new URL(${JSON.stringify(relative)}, import.meta.url).href`
    })
    entry.code += `\nexport const __weworkStylesheets = [${urls.join(',')}];\n`
    entry.exports.push('__weworkStylesheets')
  }
}
