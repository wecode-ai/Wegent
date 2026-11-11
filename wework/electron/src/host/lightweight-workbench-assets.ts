import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/** Inline local resources so an opaque sandbox never receives DSH session access. */
export async function bundleLightweightHtml(
  directory: string,
  entry = 'view.html'
): Promise<string> {
  return bundleLightweightHtmlWithModules(directory, entry, { fs, path })
}

/** The same implementation is shipped in generated source build scripts. */
export async function bundleLightweightHtmlWithModules(
  directory: string,
  entry: string,
  modules: { fs: typeof fs; path: typeof path }
): Promise<string> {
  const { readFile, lstat, realpath } = modules.fs
  const { resolve, dirname, relative, extname, isAbsolute, sep } = modules.path
  const root = await realpath(directory)
  let total = 0
  const cache = new Map<string, string>()
  const mime: Record<string, string> = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.json': 'application/json',
  }
  async function file(path: string): Promise<Buffer> {
    const segments = relative(root, path).split(sep)
    if (isAbsolute(segments.join(sep)) || segments[0] === '..')
      throw new Error('Lightweight asset escapes its project')
    let current = root
    for (const segment of segments) {
      current = resolve(current, segment)
      if ((await lstat(current)).isSymbolicLink())
        throw new Error('Lightweight assets cannot be symbolic links')
    }
    const bytes = await readFile(path)
    total += bytes.length
    if (total > 20 * 1024 * 1024) throw new Error('Lightweight assets exceed 20 MiB')
    return bytes
  }
  async function asset(reference: string, parent: string, visiting: Set<string>): Promise<string> {
    if (reference.startsWith('data:') || reference.startsWith('#')) return reference
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(reference) ||
      reference.startsWith('//') ||
      reference.startsWith('/')
    )
      throw new Error('Lightweight resources must be local assets')
    const path = resolve(dirname(parent), decodeURIComponent(reference.split(/[?#]/)[0]!))
    const cached = cache.get(path)
    if (cached) return cached
    if (visiting.has(path)) throw new Error('Cyclic lightweight resource imports are unsupported')
    const next = new Set(visiting).add(path)
    const extension = extname(path).toLowerCase()
    const type = mime[extension]
    if (!type) throw new Error(`Unsupported lightweight resource: ${extension}`)
    let bytes = await file(path)
    if (extension === '.css') {
      bytes = Buffer.from(
        await replace(
          bytes.toString('utf8'),
          /url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g,
          async match => `url("${await asset(match[2]!, path, next)}")`
        )
      )
    } else if (extension === '.js' || extension === '.mjs') {
      bytes = Buffer.from(
        await replace(
          bytes.toString('utf8'),
          /\b(from\s*|import\s*\(?\s*)(['"])([^'"]+)\2/g,
          async match => `${match[1]}${match[2]}${await asset(match[3]!, path, next)}${match[2]}`
        )
      )
    }
    const result = `data:${type};base64,${bytes.toString('base64')}`
    cache.set(path, result)
    return result
  }
  async function replace(
    source: string,
    pattern: RegExp,
    convert: (match: RegExpMatchArray) => Promise<string>
  ): Promise<string> {
    const matches = [...source.matchAll(pattern)]
    for (const match of matches.reverse()) {
      const index = match.index!
      source =
        source.slice(0, index) + (await convert(match)) + source.slice(index + match[0].length)
    }
    return source
  }
  const path = resolve(root, entry)
  let html = (await file(path)).toString('utf8')
  html = await replace(html, /<(script|link|img|audio|video|source)\b[^>]*>/gi, async tag =>
    replace(
      tag[0],
      /\b(src|href|poster)\s*=\s*(['"])([^'"]+)\2/gi,
      async match => `${match[1]}=${match[2]}${await asset(match[3]!, path, new Set())}${match[2]}`
    )
  )
  html = await replace(
    html,
    /url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g,
    async match => `url("${await asset(match[2]!, path, new Set())}")`
  )
  return html
}
