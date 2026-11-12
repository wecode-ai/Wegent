// @vitest-environment node

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, test } from 'vitest'
import {
  archiveRegressionPayload,
  verifySmartAppArchiveRegression,
} from '../e2e/desktop/modules/smart-app-archive-regression.mjs'
import { verifySmartAppMarketplaceIdentity } from '../e2e/desktop/modules/smart-app-marketplace-identity.mjs'
import { verifyWorkbenchEntriesWithoutExperimentalFeatures } from '../e2e/desktop/modules/harness-app-fixture.mjs'

// Protocol coverage only; harness-app-lifecycle retains real Electron, storage, and DSH in CI.
async function archiveFixture({ rejectConfirmation = false, corruptVersion = null } = {}) {
  const translations = JSON.parse(
    await readFile(new URL('../src/i18n/locales/zh-CN/common.json', import.meta.url), 'utf8')
  )
  const root = await mkdtemp(join(tmpdir(), 'smart-app-archive-protocol-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const appRoot = join(root, 'harness-apps')
  await mkdir(appRoot)
  const installations = new Map()
  const events = []
  const marketId = 'market-23'
  const importedId = 'dsh-e2e-archive-imported'
  const fixture = {
    sources: ['first-release', 'second-release'],
    invalid: '/invalid.zip',
    imported: '/imported.zip',
  }
  let version = '1.0.0'
  let view = 'owned'
  let pending = null
  let preview = false
  let removing = null
  let importError = null
  const persist = () =>
    writeFile(join(appRoot, 'installations.json'), JSON.stringify([...installations.values()]))
  const control = {
    async command(action, selector, options = {}) {
      if (action === 'navigate') {
        view = new URL(options.value, 'http://127.0.0.1').searchParams.get('view') ?? 'owned'
        events.push(`view:${view}`)
      } else if (action === 'workbenchApp') {
        const request = JSON.parse(options.value)
        assert.equal(request.action, 'installation')
        assert.ok(pending, 'Native confirmation requires a pending installation')
        if (request.choice === undefined) return JSON.stringify({ visible: true, ready: true })
        assert.equal(request.choice, 'accept')
        events.push(`accepted:${pending.id}:${pending.version}`)
        if (rejectConfirmation) return JSON.stringify({ clicked: false })
        const packagePath = join(appRoot, `${pending.id}-${pending.version}`)
        await mkdir(join(packagePath, 'web/vendor'), { recursive: true })
        const payload = archiveRegressionPayload(pending.version)
        if (pending.version === corruptVersion) payload[0] ^= 1
        await writeFile(join(packagePath, 'web/vendor/archive-regression.bin'), payload)
        installations.set(pending.id, {
          id: pending.id,
          manifest: { version: pending.version },
          packagePath,
        })
        await persist()
        pending = null
        preview = false
        return JSON.stringify({ clicked: true })
      } else if (action === 'dropPaths') {
        const [entry] = JSON.parse(options.value)
        importError = null
        if (entry.uri.endsWith('/invalid.zip')) {
          importError = translations.workbench.smart_apps_import_failed
          events.push('invalid:rejected')
        } else {
          pending = { id: importedId, version: '1.0.0' }
          events.push('import:pending')
        }
      } else if (action === 'clickWhenEnabled') {
        assert.ok(selector.includes('harness-app-install-confirm'))
        assert.equal(preview, true)
        pending = { id: marketId, version }
        events.push(`market:pending:${version}`)
      } else if (action === 'click') {
        if (selector.includes('smart-app-marketplace-install-')) preview = true
        else if (selector.includes('smart-app-remove-local-confirm')) {
          assert.ok(installations.delete(removing))
          events.push(`removed:${removing}`)
          await persist()
        } else if (selector.includes('smart-app-remove-local-')) {
          removing = selector.match(/smart-app-remove-local-([^"]+)/)[1]
        } else assert.ok(selector.includes('smart-app-actions-'), selector)
      } else if (action === 'getElementCount') {
        if (selector.includes('harness-app-preview')) {
          assert.equal(pending, null, 'Native installation confirmation is still pending')
          return Number(preview)
        }
        assert.ok(selector.includes('smart-app-actions-'))
        return 0
      } else {
        assert.equal(action, 'waitFor')
        if (selector.includes('[role="alert"]')) {
          assert.ok(importError, 'An invalid archive must expose its import error')
          assert.equal(
            options.text,
            importError,
            'Archive import alert must match the current translated failure'
          )
        }
        if (selector.includes('smart-app-marketplace-install-'))
          assert.equal(
            view,
            'marketplace',
            'Market install controls are absent from the owned view'
          )
        if (selector.includes('harness-app-preview')) assert.equal(preview, true)
        if (
          selector.includes('harness-app-start-') ||
          selector.includes(`smart-app-created-item-${importedId}`)
        ) {
          assert.equal(pending, null, 'Native installation confirmation is still pending')
          assert.ok(
            installations.has(selector.includes('harness-app-start-') ? marketId : importedId)
          )
        }
      }
      return ''
    },
  }
  return {
    control,
    events,
    root,
    run: () =>
      verifySmartAppArchiveRegression(control, {
        fixture,
        electronUserDataDirectory: root,
        uiTimeoutMs: 10_000,
        ownerRequest: async () => ({
          items: [{ id: 23, name: 'dsh-e2e-archive-regression', sourceType: 'official' }],
        }),
        publishUpdatedRelease: async source => {
          assert.equal(source, fixture.sources[1])
          version = '2.0.0'
          events.push('release:2.0.0')
        },
      }),
  }
}

async function identityFixture({
  rejectConfiguration = false,
  inheritedOwnerActions = false,
} = {}) {
  const translations = JSON.parse(
    await readFile(new URL('../src/i18n/locales/zh-CN/common.json', import.meta.url), 'utf8')
  )
  const installationId = 'dsh-e2e-smoke'
  const publicationId = 7
  const marketId = 23
  const events = []
  const tabs = new Set(['management'])
  const appTab = `harness-market-${marketId}`
  const marketItem = {
    id: marketId,
    name: installationId,
    sourceType: 'official',
    summary: 'Official app',
    displayName: 'Official app',
    iconUrl: 'https://catalog.invalid/icon.png',
  }
  let localInstalled = true
  let marketInstalled = false
  let pending = false
  let presentation = 'window'
  let selectedTab = 'management'
  let location = '/sites?app_type=smart_app&view=owned'
  let removing = null
  let deepLinkId = null
  let missingAttempts = 0
  const response = (result, error) =>
    JSON.stringify({
      status: error ? 400 : 200,
      body: JSON.stringify(error ? { ok: false, error } : { ok: true, result }),
    })
  const control = {
    async command(action, selector, options = {}) {
      if (action === 'getLocationOrigin') return 'http://127.0.0.1:9000'
      if (action === 'fetchLocalRuntime') {
        const request = JSON.parse(options.value)
        assert.equal(request.url, 'http://127.0.0.1:9000/wework/electron-host/v1/invoke')
        const { capability, params } = JSON.parse(request.body)
        assert.equal(capability, 'smartApps.configure')
        assert.deepEqual(params, {
          installationId: `market-${marketId}`,
          presentation: 'tab',
          background: false,
        })
        assert.equal(marketInstalled, true)
        events.push('configured:tab')
        if (rejectConfiguration) return response(null, { message: 'Tab configuration failed' })
        presentation = params.presentation
        return response({ id: params.installationId, presentation })
      }
      if (action === 'workbenchApp') {
        const request = JSON.parse(options.value)
        assert.equal(request.action, 'installation')
        assert.equal(pending, true)
        if (request.choice === undefined) return JSON.stringify({ visible: true, ready: true })
        assert.equal(request.choice, 'accept')
        pending = false
        marketInstalled = true
        events.push('accepted:market')
        return JSON.stringify({ clicked: true })
      }
      if (action === 'navigate') location = options.value
      else if (action === 'getAttribute') {
        if (options.value === 'data-workspace-tab-content') return 'management'
        if (options.value === 'data-workspace-tab-id') return appTab
        assert.equal(options.value, 'src')
        return 'https://cache.invalid/icon.png'
      } else if (action === 'getText')
        return inheritedOwnerActions ? '市场安装 管理范围' : '市场安装'
      else if (action === 'getElementCount') return 0
      else if (action === 'snapshot')
        return JSON.stringify({
          location,
          testIds: [...tabs].map(id => `workspace-tab-select-${id}`),
        })
      else if (action === 'clickWhenEnabled') {
        assert.ok(selector.includes('harness-app-install-confirm'))
        pending = true
        events.push('install:pending')
      } else if (action === 'click') {
        if (selector.includes('smart-app-deep-link-retry')) {
          assert.equal(deepLinkId, 2147483647)
          assert.equal(missingAttempts, 1)
          missingAttempts += 1
          events.push('deep-link:retry')
        } else if (selector.includes('smart-app-remove-local-confirm')) {
          if (removing === installationId) localInstalled = false
          else {
            assert.equal(removing, `market-${marketId}`)
            marketInstalled = false
            tabs.delete(appTab)
          }
        } else if (selector.includes('smart-app-remove-local-'))
          removing = selector.match(/smart-app-remove-local-([^"]+)/)[1]
        else if (selector.includes('workspace-tab-select-')) {
          selectedTab = selector.match(/workspace-tab-select-([^"]+)/)[1]
          location =
            selectedTab === appTab
              ? `/app/harness-market-${marketId}`
              : '/sites?app_type=smart_app&view=owned'
        }
      } else if (action === 'openWeworkScheme') {
        const id = Number(new URL(options.value).pathname.slice(1))
        deepLinkId = id
        if (id === marketId && marketInstalled) {
          assert.equal(
            presentation,
            'tab',
            'Deep link uses the default window without an explicit tab prerequisite'
          )
          events.push(tabs.has(appTab) ? 'deep-link:reused' : 'deep-link:created')
          tabs.add(appTab)
          selectedTab = appTab
          location = `/app/harness-market-${marketId}`
        } else {
          assert.equal(marketInstalled, false)
          events.push(id === marketId ? 'deep-link:uninstalled' : 'deep-link:missing')
          if (id !== marketId) missingAttempts = 1
          location = `/sites?app_type=smart_app&smartAppId=${id}`
        }
      } else if (action === 'waitFor') {
        if (selector.includes('smart-app-deep-link-install-prompt')) {
          assert.equal(deepLinkId, marketId)
          assert.equal(marketInstalled, false)
          assert.equal(options.timeoutMs, 10_000)
          assert.equal(
            options.text,
            translations.workbench.smart_apps_deep_link_install_title,
            'Uninstalled deep link must match the current translated install prompt'
          )
          events.push('copy:install-prompt')
        }
        if (selector.includes('smart-app-deep-link-error')) {
          assert.equal(deepLinkId, 2147483647)
          assert.equal(missingAttempts === 1 || missingAttempts === 2, true)
          assert.equal(options.timeoutMs, 10_000)
          assert.equal(
            options.text,
            translations.workbench.smart_apps_deep_link_unavailable,
            'Unknown deep link must match the current translated unavailable error'
          )
          events.push(missingAttempts === 1 ? 'copy:unknown' : 'copy:retry')
        }
        if (selector.includes('harness-app-start-market-')) {
          assert.equal(pending, false, 'Native installation confirmation is still pending')
          assert.equal(marketInstalled, true)
        }
        if (selector.includes('app-iframe-harness-')) assert.equal(selectedTab, appTab)
        if (selector.includes('workspace-tab-select-'))
          assert.ok(selector.includes(`workspace-tab-select-${selectedTab}`))
        if (options.text === '还没有符合条件的工作台') {
          assert.equal(localInstalled, false)
          assert.equal(marketInstalled, false)
        }
      } else assert.equal(action, 'select')
      return ''
    },
  }
  return {
    control,
    events,
    run: () =>
      verifySmartAppMarketplaceIdentity({
        control,
        installationId,
        publicationId,
        uiTimeoutMs: 10_000,
        captureScreenshot: async (_control, name) => events.push(`screenshot:${name}`),
        ownerRequest: async path =>
          path === '/api/smart-apps/marketplace'
            ? { items: [marketItem] }
            : { items: [{ id: publicationId, name: installationId }] },
      }),
  }
}

test('archive lifecycle explicitly enters marketplace and accepts each native install while retaining byte checks and cleanup', async () => {
  const app = await archiveFixture()
  await app.run()
  assert.deepEqual(app.events, [
    'view:marketplace',
    'market:pending:1.0.0',
    'accepted:market-23:1.0.0',
    'release:2.0.0',
    'view:marketplace',
    'market:pending:2.0.0',
    'accepted:market-23:2.0.0',
    'view:owned',
    'invalid:rejected',
    'import:pending',
    'accepted:dsh-e2e-archive-imported:1.0.0',
    'removed:dsh-e2e-archive-imported',
    'removed:market-23',
  ])
  assert.deepEqual(
    JSON.parse(await readFile(join(app.root, 'harness-apps/installations.json'), 'utf8')),
    []
  )
})

test('archive lifecycle fails native confirmation rejection before claiming installation success', async () => {
  const app = await archiveFixture({ rejectConfirmation: true })
  await assert.rejects(app.run(), /clicked/)
  assert.equal(app.events.includes('release:2.0.0'), false)
})

test('archive lifecycle retains the exact delivered-byte assertion for an updated package', async () => {
  const app = await archiveFixture({ corruptVersion: '2.0.0' })
  await assert.rejects(app.run(), /Installed ZIP entry was truncated or corrupted/)
})

test('archive lifecycle rejects the obsolete Smart Workbench import failure copy', async () => {
  const app = await archiveFixture()
  const command = app.control.command
  app.control.command = (action, selector, options = {}) =>
    command(
      action,
      selector,
      action === 'waitFor' && selector.includes('[role="alert"]')
        ? { ...options, text: '智能工作台导入失败' }
        : options
    )
  await assert.rejects(app.run(), /Archive import alert must match the current translated failure/)
  assert.equal(app.events.includes('invalid:rejected'), true)
  assert.equal(app.events.includes('import:pending'), false)
})

test('marketplace identity accepts native installation and configures its own tab before checking deep-link reuse', async () => {
  const app = await identityFixture()
  await app.run()
  assert.deepEqual(app.events.slice(0, 5), [
    'install:pending',
    'accepted:market',
    'configured:tab',
    'deep-link:created',
    'deep-link:reused',
  ])
  assert.ok(app.events.includes('deep-link:uninstalled'))
  assert.ok(app.events.includes('deep-link:missing'))
  assert.deepEqual(
    app.events.filter(event => event.startsWith('copy:') || event === 'deep-link:retry'),
    ['copy:install-prompt', 'copy:unknown', 'deep-link:retry', 'copy:retry']
  )
  assert.deepEqual(
    app.events.filter(event => event.startsWith('screenshot:')),
    [
      'screenshot:harness-apps-15b-marketplace-identity.png',
      'screenshot:harness-apps-15c-deep-link-install.png',
      'screenshot:harness-apps-15d-deep-link-retry.png',
    ]
  )
})

test('marketplace identity propagates Host configuration failure before deep-link launch', async () => {
  const app = await identityFixture({ rejectConfiguration: true })
  await assert.rejects(app.run(), /Host smartApps.configure returned HTTP 400/)
  assert.equal(
    app.events.some(event => event.startsWith('deep-link:')),
    false
  )
})

test('marketplace identity still rejects owner actions inherited from the same-name publication', async () => {
  const app = await identityFixture({ inheritedOwnerActions: true })
  await assert.rejects(app.run(), /Market installation inherited historical owner actions/)
})

test.each([
  {
    phase: 'install prompt',
    selector: '[data-testid="smart-app-deep-link-install-prompt"]',
    occurrence: 1,
    obsolete: '此智能工作台尚未安装',
    error: /Uninstalled deep link must match the current translated install prompt/,
    prior: [],
  },
  {
    phase: 'unknown target',
    selector: '[data-testid="smart-app-deep-link-error"]',
    occurrence: 1,
    obsolete: '未找到此智能工作台',
    error: /Unknown deep link must match the current translated unavailable error/,
    prior: ['copy:install-prompt'],
  },
  {
    phase: 'unknown target retry',
    selector: '[data-testid="smart-app-deep-link-error"]',
    occurrence: 2,
    obsolete: '未找到此智能工作台',
    error: /Unknown deep link must match the current translated unavailable error/,
    prior: ['copy:install-prompt', 'copy:unknown', 'deep-link:retry'],
  },
])('marketplace identity rejects obsolete copy at $phase', async entry => {
  const app = await identityFixture()
  const command = app.control.command
  let seen = 0
  app.control.command = (action, selector, options = {}) => {
    const target = action === 'waitFor' && selector === entry.selector
    if (target) seen += 1
    return command(
      action,
      selector,
      target && seen === entry.occurrence ? { ...options, text: entry.obsolete } : options
    )
  }
  await assert.rejects(app.run(), entry.error)
  assert.equal(seen, entry.occurrence)
  assert.deepEqual(
    app.events.filter(event => event.startsWith('copy:') || event === 'deep-link:retry'),
    entry.prior
  )
  assert.equal(app.events.includes('screenshot:harness-apps-15d-deep-link-retry.png'), false)
})

function experimentalEntriesFixture({
  applicationsVisible = 1,
  applicationsHidden = 3,
  menuVisible = 1,
  menuHidden = 3,
  blockedReadiness = null,
} = {}) {
  const active = '[data-workspace-tab-content][aria-hidden="false"]'
  const events = []
  let route = '/'
  let experimental = true
  let applicationsReady = false
  let menuRequested = false
  let menuReady = false
  const entryNodes = (testId, count, owner, visible) =>
    Array.from({ length: count }, () => ({ testId, owner, visible }))
  const nodes = () => [
    ...entryNodes('sites-workspace', applicationsHidden, { active: false }, false),
    ...entryNodes('applications-tab-smart-app', applicationsHidden, { active: false }, false),
    ...entryNodes('sites-workspace', Number(applicationsReady), { active: true }, route === '/sites'),
    ...entryNodes(
      'applications-tab-smart-app',
      applicationsReady ? applicationsVisible : 0,
      { active: true },
      route === '/sites'
    ),
    ...entryNodes('workspace-tab-add', 1, null, route === '/'),
    ...entryNodes('workspace-tab-add-menu', menuHidden, null, false),
    ...entryNodes('workspace-tab-add-smart-app', menuHidden, null, false),
    ...entryNodes('workspace-tab-add-menu', Number(menuReady), null, route === '/'),
    ...entryNodes('workspace-tab-add-smart-app', menuReady ? menuVisible : 0, null, route === '/'),
  ]
  const query = (selector, visible) => {
    const testId = selector.match(/\[data-testid="([^"]+)"\]/)?.[1]
    assert.ok(testId, `Unsupported protocol fixture selector: ${selector}`)
    return nodes().filter(
      node =>
        node.testId === testId &&
        (!selector.includes('[data-workspace-tab-content]') || node.owner?.active) &&
        (!visible || node.visible)
    )
  }
  const phaseFor = selector => {
    if (selector.includes('sites-workspace') || selector.includes('applications-tab-smart-app'))
      return 'applications'
    if (selector.includes('workspace-tab-add-menu') || selector.includes('workspace-tab-add-smart-app'))
      return 'menu'
    return null
  }
  const control = {
    async command(action, selector, options = {}) {
      if (action === 'navigate') {
        route = options.value
        assert.ok(['/settings/general', '/sites', '/'].includes(route))
        if (route === '/sites') applicationsReady = false
      } else if (selector.includes('general-experimental-features-toggle')) {
        assert.equal(route, '/settings/general')
        if (action === 'getAttribute') return String(experimental)
        if (action === 'click') experimental = !experimental
        else {
          assert.equal(action, 'waitFor')
          assert.equal(options.timeoutMs, 10_000)
          if (selector.includes('aria-checked')) assert.equal(experimental, false)
        }
      } else if (action === 'click') {
        assert.equal(selector, '[data-testid="workspace-tab-add"]')
        assert.equal(query(selector, true).length, 1)
        menuRequested = true
        events.push('menu:requested')
      } else if (action === 'waitFor') {
        assert.equal(options.timeoutMs, 10_000)
        const phase = phaseFor(selector)
        if (!query(selector, options.visible).length && phase) {
          assert.notEqual(blockedReadiness, phase, `${phase} readiness failed`)
          assert.equal(experimental, false)
          if (phase === 'applications') {
            assert.equal(route, '/sites')
            applicationsReady = true
          } else {
            assert.equal(menuRequested, true)
            menuReady = true
          }
          events.push(`ready:${phase}`)
        }
        if (!query(selector, options.visible).length) {
          events.push(`missing:${phase}`)
          assert.fail(`${phase} has no matching visible entry`)
        }
      } else {
        assert.equal(action, 'getElementCount')
        const count = query(selector, options.visible).length
        events.push(`count:${phaseFor(selector)}:${count}`)
        return String(count)
      }
      return ''
    },
  }
  return {
    events,
    run: () =>
      verifyWorkbenchEntriesWithoutExperimentalFeatures(control, {
        activeWorkspaceContentSelector: active,
        uiTimeoutMs: 10_000,
        captureScreenshot: async () => events.push('screenshot'),
      }),
  }
}

test('experimental-disabled entry checks wait for the current page and portal menu while excluding retained hidden entries', async () => {
  const app = experimentalEntriesFixture()
  await app.run()
  assert.deepEqual(app.events, [
    'ready:applications',
    'count:applications:1',
    'menu:requested',
    'ready:menu',
    'count:menu:1',
    'screenshot',
  ])
})

test.each([
  { phase: 'applications', visible: 0, options: { applicationsVisible: 0, applicationsHidden: 1 } },
  { phase: 'applications', visible: 2, options: { applicationsVisible: 2 } },
  { phase: 'menu', visible: 0, options: { menuVisible: 0, menuHidden: 1 } },
  { phase: 'menu', visible: 2, options: { menuVisible: 2 } },
])('experimental-disabled checks reject $visible visible $phase entries', async entry => {
  const app = experimentalEntriesFixture(entry.options)
  await assert.rejects(app.run(), { code: 'ERR_ASSERTION' })
  assert.ok(
    app.events.includes(
      entry.visible ? `count:${entry.phase}:${entry.visible}` : `missing:${entry.phase}`
    )
  )
  assert.equal(app.events.includes('screenshot'), false)
})

test.each(['applications', 'menu'])(
  'experimental-disabled checks propagate %s readiness failures before counting entries',
  async phase => {
    const app = experimentalEntriesFixture({ blockedReadiness: phase })
    await assert.rejects(app.run(), new RegExp(`${phase} readiness failed`))
    assert.equal(app.events.some(event => event.startsWith(`count:${phase}:`)), false)
    assert.equal(app.events.includes('screenshot'), false)
  }
)
