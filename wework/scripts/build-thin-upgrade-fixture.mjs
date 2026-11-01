import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { portableDesktopRelease } from './lib/portable-desktop-release.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pairFile = resolve(process.argv[2])
const pair = JSON.parse(await readFile(pairFile, 'utf8'))
const sourceVersion = '0.6.3'
const output = join(dirname(pairFile), 'thin-source')
await new Promise((accept, reject) => {
  const child = spawn(process.execPath, ['scripts/package-app.mjs'], {
    cwd: join(root, 'electron'),
    env: {
      ...process.env,
      WEWORK_UPGRADE_FIXTURE_VERSION: sourceVersion,
      WEWORK_UPGRADE_FIXTURE_DATA_SCHEMA: String(pair.to.dataSchema),
      WEWORK_UPGRADE_FIXTURE_OUTPUT: output,
      WEWORK_UPGRADE_FIXTURE_THIN_SOURCE: '1',
      WEWORK_UPGRADE_FIXTURE_APP_ID: pair.fixtureApplicationId,
      WEWORK_UPGRADE_FIXTURE_LEGACY_BOOTSTRAP: '1',
    },
    stdio: 'inherit',
  })
  child.once('error', reject)
  child.once('exit', code =>
    code === 0 ? accept() : reject(new Error(`Thin packaging exited: ${code}`))
  )
})
const application = join(output, 'packaged', `WeWork-${process.platform}-${process.arch}`)
const appRoot = process.platform === 'darwin' ? join(application, 'WeWork.app') : application
const asset = await portableDesktopRelease({
  appRoot,
  version: sourceVersion,
  platform: pair.from.platform,
  arch: pair.from.arch,
  output,
  fixture: true,
})
const executable =
  process.platform === 'darwin'
    ? join(appRoot, 'Contents/MacOS/WeWork')
    : join(appRoot, process.platform === 'win32' ? 'WeWork.exe' : 'WeWork')
const thinPairFile = join(output, 'pair.json')
const from = { ...asset, executable, executor: pair.from.executor, installedSource: pair.from }
await writeFile(thinPairFile, JSON.stringify({ ...pair, from }, null, 2) + '\n')
await writeFile(
  pairFile,
  JSON.stringify({ ...pair, thinSource: from, thinPairFile }, null, 2) + '\n'
)
