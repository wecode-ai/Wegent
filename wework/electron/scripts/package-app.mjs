import { packager } from '@electron/packager'
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(electronRoot, 'release')
const staging = join(electronRoot, '.package-staging')
const electronZipDir = process.env.WEWORK_ELECTRON_ZIP_DIR?.trim() || undefined
const sharedResourcesRoot = join(electronRoot, '..', 'resources')
const icon =
  process.platform === 'darwin'
    ? join(sharedResourcesRoot, 'icons', 'icon.icns')
    : process.platform === 'win32'
      ? join(sharedResourcesRoot, 'icons', 'icon.ico')
      : undefined

await Promise.all([
  rm(output, { recursive: true, force: true }),
  rm(staging, { recursive: true, force: true }),
])
await mkdir(staging, { recursive: true, mode: 0o700 })
await cp(join(electronRoot, 'dist'), join(staging, 'dist'), { recursive: true })
const sourcePackage = JSON.parse(await readFile(join(electronRoot, 'package.json'), 'utf8'))
await writeFile(
  join(staging, 'package.json'),
  `${JSON.stringify(
    {
      name: sourcePackage.name,
      productName: 'WeWork',
      version: sourcePackage.version,
      type: sourcePackage.type,
      main: sourcePackage.main,
      dependencies: sourcePackage.dependencies,
    },
    null,
    2
  )}\n`
)
await run(
  'npm',
  ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'],
  staging
)
const applications = await packager({
  dir: staging,
  name: 'WeWork',
  electronVersion: '43.4.1',
  electronZipDir,
  appBundleId: 'io.wecode.wework',
  appVersion: sourcePackage.version,
  buildVersion: sourcePackage.version,
  executableName: 'WeWork',
  out: output,
  overwrite: true,
  asar: {
    unpack: '**/*.node',
  },
  extraResource: [
    join(electronRoot, 'resources', 'harness-runtime'),
    join(electronRoot, 'resources', 'node-runtime'),
    join(electronRoot, 'resources', 'bin'),
    join(electronRoot, 'resources', 'bundled-plugins'),
    join(sharedResourcesRoot, 'icons'),
  ],
  icon,
  prune: false,
})

await rm(staging, { recursive: true, force: true })
console.log(JSON.stringify({ applications }, null, 2))

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}
