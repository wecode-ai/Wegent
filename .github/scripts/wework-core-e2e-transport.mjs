import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const codexTarget = 'x86_64-unknown-linux-gnu'

function files(root) {
  if (!lstatSync(root).isDirectory())
    throw new Error(`Expected directory: ${root}`)
  const result = []
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) result.push(path)
    }
  }
  visit(root)
  return result
}

async function checksum(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function deduplicateCodex(buildDir) {
  const packaged = join(buildDir, 'electron-app/resources/codex')
  const external = join(buildDir, 'codex', codexTarget)
  const candidates = new Map(
    files(packaged).map((path) => [relative(packaged, path), path]),
  )
  let bytes = 0
  let count = 0
  for (const path of files(external)) {
    const source = candidates.get(relative(external, path))
    if (!source) continue
    const actual = lstatSync(path)
    const expected = lstatSync(source)
    if (
      actual.size !== expected.size ||
      (actual.mode & 0o7777) !== (expected.mode & 0o7777)
    )
      continue
    if ((await checksum(path)) !== (await checksum(source))) continue
    // Only the disposable staging copy shares an inode; managed source bytes stay untouched.
    unlinkSync(path)
    linkSync(source, path)
    bytes += actual.size
    count += 1
  }
  console.log(
    `[wework-core-e2e-build] transport-deduplicate files=${count} bytes=${bytes}`,
  )
  return { files: count, bytes }
}

export function materializeCodex(buildDir) {
  let count = 0
  for (const path of files(join(buildDir, 'codex', codexTarget))) {
    const stat = lstatSync(path)
    if (stat.nlink <= 1) continue
    const directory = mkdtempSync(join(dirname(path), '.ci-codex-copy-'))
    try {
      const copy = join(directory, 'file')
      copyFileSync(path, copy)
      chmodSync(copy, stat.mode & 0o7777)
      utimesSync(copy, stat.atime, stat.mtime)
      // A replace or in-place update of the external CLI must never alter the packaged component.
      renameSync(copy, path)
      count += 1
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  console.log(`[wework-core-e2e-build] transport-materialize files=${count}`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [mode, buildDir] = process.argv.slice(2)
  if (!buildDir) throw new Error('A desktop build directory is required')
  if (mode === 'deduplicate') await deduplicateCodex(buildDir)
  else if (mode === 'materialize') materializeCodex(buildDir)
  else throw new Error(`Unknown transport operation: ${mode}`)
}
