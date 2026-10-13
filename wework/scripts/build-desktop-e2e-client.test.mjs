import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const execute = promisify(execFile)

test('loads Socket.IO and parses marketplace TOML from a standalone E2E artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-e2e-client-'))
  try {
    await execute(
      process.execPath,
      [fileURLToPath(new URL('./build-desktop-e2e-client.mjs', import.meta.url)), root],
      { timeout: 30_000 }
    )
    const helper = join(root, 'marketplace-config.mjs')
    await copyFile(
      new URL('../e2e/desktop/modules/marketplace-config.mjs', import.meta.url),
      helper
    )
    const { stdout } = await execute(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { createRequire } from 'node:module'
import { matchesBundledMarketplaceConfig } from ${JSON.stringify(pathToFileURL(helper).href)}
const { io } = createRequire(import.meta.url)(${JSON.stringify(join(root, 'socket.io-client.cjs'))})
const source = String.raw\`D:\\Wework\\bundled-marketplaces\\wework-personal\`
const config = \`[marketplaces.wework-personal]\nsource_type = "local"\nsource = '\${source}'\`
console.log(JSON.stringify({ socket: typeof io, matches: matchesBundledMarketplaceConfig(config, source) }))`,
      ],
      {
        cwd: root,
        env: { ...process.env, WEWORK_E2E_TOML_PARSER: join(root, 'smol-toml.cjs') },
        timeout: 10_000,
      }
    )
    expect(JSON.parse(stdout)).toEqual({ socket: 'function', matches: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
