import { ZipArchive } from 'archiver'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const run = promisify(execFile)

async function emitRuntimeModules(root: string): Promise<URL> {
  const sourceRoot = new URL('../', import.meta.url)
  const output = join(root, 'runtime')
  const emitted = new Set<string>()
  await mkdir(output)
  await writeFile(join(output, 'package.json'), '{"type":"module"}')
  await symlink(
    fileURLToPath(new URL('../../node_modules/', import.meta.url)),
    join(output, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  async function emit(source: URL): Promise<URL> {
    const name = relative(fileURLToPath(sourceRoot), fileURLToPath(source))
    const destination = join(output, name.replace(/\.ts$/, '.js'))
    if (emitted.has(source.href)) return pathToFileURL(destination)
    emitted.add(source.href)
    const { outputText } = ts.transpileModule(await readFile(source, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    })
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, outputText)
    for (const dependency of ts.preProcessFile(outputText).importedFiles) {
      if (dependency.fileName.startsWith('.') && dependency.fileName.endsWith('.js')) {
        await emit(new URL(dependency.fileName.replace(/\.js$/, '.ts'), source))
      }
    }
    return pathToFileURL(destination)
  }
  return emit(new URL('./smart-app-package-validator.ts', import.meta.url))
}

test('Electron extracts a deflated Smart App asset through EOF under backpressure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-zip-runtime-'))
  // Repeated hash blocks expand enough to apply inflate backpressure while the
  // compressed entry exceeds both Windows and macOS stream high water marks.
  const content = Array.from({ length: 4096 }, (_, index) =>
    createHash('sha256').update(String(index)).digest('hex').repeat(4)
  ).join('\n')
  const archivePath = join(root, 'smart-app.zip')
  const destination = join(root, 'extracted')
  try {
    // Run emitted production modules with Electron's real stream implementation.
    const validator = await emitRuntimeModules(root)
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(archivePath)
      const archive = new ZipArchive({ zlib: { level: 9 } })
      output.once('close', resolve)
      output.once('error', reject)
      archive.once('error', reject)
      archive.pipe(output)
      archive.append(content, { name: 'terminal-workbench/lib/client.js' })
      void archive.finalize()
    })
    expect((await readFile(archivePath)).byteLength).toBeGreaterThan(128 * 1024)

    await run(
      require('electron') as string,
      [
        '--input-type=module',
        '-e',
        `import(process.argv[1])
          .then(({ extractSmartAppArchive }) => extractSmartAppArchive(process.argv[2], process.argv[3]))
          .then(() => console.log('extracted'))
          .catch(error => { console.error(error); process.exitCode = 1 })`,
        validator.href,
        archivePath,
        destination,
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 5000 }
    ).then(({ stdout }) => expect(stdout.trim()).toBe('extracted'))

    expect(await readFile(join(destination, 'terminal-workbench/lib/client.js'), 'utf8')).toBe(
      content
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)
