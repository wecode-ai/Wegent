import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'harness-runtime')
const target = path.join(root, 'src-tauri', 'bundled-deepseek-harness')
const placeholder = path.join(target, '.resource-placeholder')

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

if (process.argv.includes('--clean')) {
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await writeFile(placeholder, '')
  process.exit(0)
}

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(path.join(source, 'package.json'), path.join(target, 'package.json'))
await cp(path.join(source, 'pnpm-lock.yaml'), path.join(target, 'pnpm-lock.yaml'))
await cp(path.join(source, 'pnpm-workspace.yaml'), path.join(target, 'pnpm-workspace.yaml'))
await cp(path.join(source, '.npmrc'), path.join(target, '.npmrc'))
await run('pnpm', ['install', '--prod', '--frozen-lockfile'], target)

const nodeDirectory = path.join(target, 'node', 'bin')
await mkdir(nodeDirectory, { recursive: true })
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
await cp(process.execPath, path.join(nodeDirectory, nodeName))

const packageJson = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
await writeFile(
  path.join(target, 'runtime.json'),
  `${JSON.stringify(
    {
      dshVersion: packageJson.dependencies['@deepseek-ai/dsh'],
      nodeVersion: process.version,
    },
    null,
    2
  )}\n`
)
await writeFile(placeholder, '')
