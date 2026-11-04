import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import {
  createHarnessPackage,
  createOfficialSource,
  waitForElementCount,
} from './harness-app-fixture.mjs'

const MARKET_NAME = 'dsh-e2e-archive-regression'
const IMPORT_NAME = 'dsh-e2e-archive-imported'
const PAYLOAD_PATH = 'web/vendor/archive-regression.bin'
const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'

export function archiveRegressionPayload(version) {
  const bytes = Buffer.alloc(256 * 1024)
  for (let offset = 0; offset < bytes.length; offset += 32) {
    createHash('sha256')
      .update(`smart-app-archive-${version}-${offset}`)
      .digest()
      .copy(bytes, offset)
  }
  assert.ok(
    deflateRawSync(bytes).length > 64 * 1024,
    'ZIP fixture must cross the compressed stream boundary'
  )
  return bytes
}

export async function createSmartAppArchiveRegression(resultDir) {
  const root = join(resultDir, 'archive-regression')
  const sources = []
  for (const version of ['1.0.0', '2.0.0']) {
    const directory = join(root, version)
    await mkdir(directory, { recursive: true })
    const archive = await createHarnessPackage(directory, MARKET_NAME, '0.1.0-rc.8', {
      version,
      deliveryFiles: { [PAYLOAD_PATH]: archiveRegressionPayload(version) },
    })
    sources.push(await createOfficialSource(directory, archive))
  }
  const imported = await createHarnessPackage(root, IMPORT_NAME, '0.1.0-rc.8', {
    version: '1.0.0',
    deliveryFiles: { [PAYLOAD_PATH]: archiveRegressionPayload('1.0.0') },
  })
  const invalid = join(root, 'invalid.zip')
  await writeFile(invalid, 'truncated release package')
  return { sources, imported, invalid }
}

export async function verifySmartAppArchiveRegression(
  control,
  { fixture, ownerRequest, publishUpdatedRelease, electronUserDataDirectory, uiTimeoutMs }
) {
  const catalog = await ownerRequest('/api/smart-apps/marketplace')
  const market = catalog.items.find(
    item => item.name === MARKET_NAME && item.sourceType === 'official'
  )
  assert.ok(market, 'Large-entry marketplace fixture is missing')
  const marketId = `market-${market.id}`

  for (const version of ['1.0.0', '2.0.0']) {
    if (version === '2.0.0') await publishUpdatedRelease(fixture.sources[1])
    await control.command('navigate', 'body', { value: '/sites?app_type=smart_app' })
    const install = `${ACTIVE} [data-testid="smart-app-marketplace-install-${market.id}"]`
    await control.command('waitFor', install, { enabled: true })
    await control.command('click', install)
    await control.command('waitFor', '[data-testid="harness-app-preview"]', { text: version })
    await control.command('clickWhenEnabled', '[data-testid="harness-app-install-confirm"]')
    await waitForElementCount(
      control,
      '[data-testid="harness-app-preview"]',
      0,
      uiTimeoutMs,
      'Archive installation did not finish'
    )
    await control.command('waitFor', `${ACTIVE} [data-testid="harness-app-start-${marketId}"]`)
    await assertInstalled(electronUserDataDirectory, marketId, version)
  }

  await control.command('navigate', 'body', { value: '/sites?app_type=smart_app&view=owned' })
  await control.command('waitFor', `${ACTIVE} [data-testid="smart-apps-owned-page"]`)
  await dropArchive(control, fixture.invalid)
  await control.command('waitFor', `${ACTIVE} [role="alert"]`, { text: '智能工作台导入失败' })
  await control.command('waitFor', `${ACTIVE} [data-testid="smart-apps-import-button"]`, {
    enabled: true,
  })
  await assertNoStagingDirectories(electronUserDataDirectory)

  await dropArchive(control, fixture.imported)
  await control.command(
    'waitFor',
    `${ACTIVE} [data-testid="smart-app-created-item-${IMPORT_NAME}"]`
  )
  await assertInstalled(electronUserDataDirectory, IMPORT_NAME, '1.0.0')

  for (const id of [IMPORT_NAME, marketId]) {
    await control.command('click', `${ACTIVE} [data-testid="smart-app-actions-${id}"]`)
    await control.command('waitFor', `[data-testid="smart-app-remove-local-${id}"]`)
    await control.command('click', `[data-testid="smart-app-remove-local-${id}"]`)
    await control.command('waitFor', '[data-testid="smart-app-remove-local-confirm"]')
    await control.command('click', '[data-testid="smart-app-remove-local-confirm"]')
    await waitForElementCount(
      control,
      `${ACTIVE} [data-testid="smart-app-actions-${id}"]`,
      0,
      uiTimeoutMs,
      'Archive regression installation was not removed'
    )
  }
}

async function dropArchive(control, path) {
  await control.command('dropPaths', `${ACTIVE} [data-testid="smart-apps-owned-page"]`, {
    value: JSON.stringify([
      {
        uri: pathToFileURL(path).href,
        name: path.split(/[\\/]/).pop(),
        mimeType: 'application/zip',
      },
    ]),
  })
}

async function assertInstalled(dataDirectory, id, version) {
  const root = join(dataDirectory, 'harness-apps')
  const installations = JSON.parse(await readFile(join(root, 'installations.json'), 'utf8'))
  const installed = installations.find(item => item.id === id)
  assert.equal(installed?.manifest.version, version, 'Installed registry version did not advance')
  const bytes = await readFile(join(installed.packagePath, PAYLOAD_PATH))
  assert.deepEqual(
    bytes,
    archiveRegressionPayload(version),
    'Installed ZIP entry was truncated or corrupted'
  )
  await assertNoStagingDirectories(dataDirectory)
}

async function assertNoStagingDirectories(dataDirectory) {
  const entries = await readdir(join(dataDirectory, 'harness-apps'))
  assert.deepEqual(
    entries.filter(name => /^\.(?:preview|install)-/.test(name)),
    [],
    'Extraction left temporary staging directories behind'
  )
}
