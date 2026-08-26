import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DIRECTORY_ENTRY_LIMIT = 1_000
const PREVIEW_DIRECTORY = join(tmpdir(), 'wework-embedded-browser-electron')
const BLOCKED_EXTENSIONS = new Set([
  '.7z',
  '.app',
  '.bin',
  '.bz2',
  '.dmg',
  '.doc',
  '.docx',
  '.exe',
  '.gz',
  '.iso',
  '.odt',
  '.ppt',
  '.pptx',
  '.rar',
  '.tar',
  '.xls',
  '.xlsx',
  '.xz',
  '.zip',
])

export type LocalFileNavigation =
  | { kind: 'direct'; displayUrl: string; sourceUrl: string }
  | { kind: 'preview'; displayUrl: string; sourceUrl: string }
  | { kind: 'blocked'; sourceUrl: string }

export async function prepareLocalFileNavigation(url: string): Promise<LocalFileNavigation> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'file:') {
    return { kind: 'direct', displayUrl: url, sourceUrl: url }
  }

  const path = fileURLToPath(parsed)
  const metadata = await stat(path)
  if (metadata.isDirectory()) {
    return {
      kind: 'preview',
      displayUrl: await writeDirectoryPreview(path),
      sourceUrl: url,
    }
  }
  if (metadata.isFile() && BLOCKED_EXTENSIONS.has(extname(path).toLowerCase())) {
    return { kind: 'blocked', sourceUrl: url }
  }
  return { kind: 'direct', displayUrl: url, sourceUrl: url }
}

export function isGeneratedLocalFilePreview(url: string): boolean {
  try {
    return fileURLToPath(url).startsWith(`${PREVIEW_DIRECTORY}/`)
  } catch {
    return false
  }
}

async function writeDirectoryPreview(directory: string): Promise<string> {
  const children = await readdir(directory, { withFileTypes: true })
  children.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  })
  const visibleChildren = children.slice(0, DIRECTORY_ENTRY_LIMIT)
  const rows = await Promise.all(
    visibleChildren.map(async child => {
      const path = join(directory, child.name)
      const childMetadata = await stat(path)
      const name = child.isDirectory() ? `${child.name}/` : child.name
      const url = pathToFileURL(path).href + (child.isDirectory() ? '/' : '')
      const size = child.isDirectory() ? '' : formatFileSize(childMetadata.size)
      const modified = childMetadata.mtime.toLocaleString()
      return `<tr><td><a data-testid="embedded-browser-directory-entry" href="${escapeHtml(url)}">${escapeHtml(name)}</a></td><td>${escapeHtml(size)}</td><td>${escapeHtml(modified)}</td></tr>`
    })
  )
  const parent = pathToFileURL(join(directory, '..')).href
  const title = `Index of ${directory}`
  const truncated =
    children.length > DIRECTORY_ENTRY_LIMIT
      ? '<p class="notice">Showing the first 1,000 entries.</p>'
      : ''
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 20px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    h1 { font-size: 20px; margin: 0 0 16px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent); padding: 8px; text-align: left; }
    a { color: LinkText; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .notice { opacity: 0.7; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p><a data-testid="embedded-browser-directory-parent" href="${escapeHtml(parent)}">Parent directory</a></p>
    <table id="directory-listing">
      <thead><tr><th>Name</th><th>Size</th><th>Modified</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
    ${truncated}
  </main>
</body>
</html>`
  await mkdir(PREVIEW_DIRECTORY, { recursive: true })
  const previewPath = join(PREVIEW_DIRECTORY, `directory-${process.pid}-${randomUUID()}.html`)
  await writeFile(previewPath, html, 'utf8')
  return pathToFileURL(previewPath).href
}

function formatFileSize(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000
    unit += 1
  }
  return unit === 0 || value >= 100
    ? `${value.toFixed(0)} ${units[unit]}`
    : `${value.toFixed(1)} ${units[unit]}`
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    character =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] as string
  )
}
