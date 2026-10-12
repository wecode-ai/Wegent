import assert from 'node:assert/strict'
import { mkdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { seedNativeDshProfile } from './release-package-startup.scenario.mjs'
import { packagedResourcesRoot } from '../modules/runtime-assets.mjs'
import {
  waitForClosedStartupSplash,
  waitForStartupLogs,
} from './native-window-startup.scenario.mjs'

const LATEST_VERSION = '0.2.0-rc.2'
const LEGACY_VERSION = '0.1.0-rc.8'
const LEGACY_ID = 'existing-legacy-smart-app'

async function invoke(control, capability, params = {}) {
  const origin = await control.command('getLocationOrigin', 'body')
  const response = await fetch(`${origin}/wework/electron-host/v1/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability, params }),
  })
  const payload = await response.json()
  assert.equal(response.ok, true, `${capability}: ${JSON.stringify(payload)}`)
  assert.equal(payload.ok, true, `${capability}: ${JSON.stringify(payload)}`)
  return payload.result
}

async function createSmartAppFixture(root, name, dshVersion) {
  const packageName = `@wework-e2e/${name}`
  const bundlePath = `packages/bundle/${name}`
  const manifest = {
    name,
    displayName: name,
    version: '0.1.0',
    type: 'deepseek-harness-plugin-bundle',
    description: 'Runtime upgrade regression fixture',
    packages: [{ name: packageName, role: 'profile-bundle', path: bundlePath }],
    entry: { installPackage: bundlePath, profile: 'web' },
    requirements: { dsh: dshVersion, node: '>=22' },
  }
  const files = {
    'PLUGIN.md': '# Runtime upgrade fixture\n',
    'INSTALL.zh-CN.md': '# 安装\n',
    'plugin-manifest.json': JSON.stringify(manifest),
    [`${bundlePath}/package.json`]: JSON.stringify({
      name: packageName,
      version: '0.1.0',
      type: 'module',
      main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
    [`${bundlePath}/cordis.patch.yml`]: `- insert:\n    - id: ${name}\n      name: '${packageName}'\n`,
    [`${bundlePath}/index.js`]: `export const inject = ['webServer']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/runtime-upgrade-ready',
    handler(req, res) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ app: '${name}', dsh: '${dshVersion}' }))
    },
  }), 'runtime upgrade readiness route')
}
`,
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  return manifest
}

async function assertRuntime(control, installationId, version) {
  const installation = await invoke(control, 'smartApps.start', { installationId })
  assert.equal(installation.state, 'running')
  assert.equal(installation.runtimeVersion, version)
  const response = await fetch(new URL('/runtime-upgrade-ready', installation.webUrl))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { app: installation.manifest.name, dsh: version })
  const bridge = await fetch(new URL('/wework/electron-host/v1/invoke', installation.webUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability: 'dshCapture.capabilities', params: {} }),
  })
  const bridgePayload = await bridge.json()
  assert.equal(bridge.ok, true, `Smart app host bridge: ${JSON.stringify(bridgePayload)}`)
  assert.equal(bridgePayload.ok, true)
  await invoke(control, 'smartApps.stop', { installationId })
}

async function verifySmartAppTemplates(control, resultDir) {
  const templates = ['web', 'host', 'web-host', 'web-host-remote']
  for (const template of templates) {
    const installation = await invoke(control, 'smartApps.createDirectory', {
      parentPath: resultDir,
      name: `runtime-template-${template}`,
      displayName: `Runtime template ${template}`,
      description: 'Verify the generated template against the official latest runtime',
      template,
    })
    assert.equal(installation.manifest.requirements.dsh, LATEST_VERSION)
    const report = await invoke(control, 'smartApps.verify', { installationId: installation.id })
    assert.equal(report.status, 'passed', `${template}: ${JSON.stringify(report)}`)
    assert.deepEqual(
      report.stages.map(stage => [stage.stage, stage.status]),
      ['manifest', 'scripts', 'artifacts', 'runtime'].map(stage => [stage, 'passed'])
    )
  }
  return templates
}

async function assertStartupBudget(control, resultDir, label) {
  await waitForClosedStartupSplash(control)
  const log = await waitForStartupLogs(resultDir)
  const startupStages = [...log.matchAll(/\[startup\]\s+\{([\s\S]*?)\}/g)].map(match => match[1])
  const runtimeConfiguration = startupStages.findLastIndex(
    stage => stage.includes("step: 'runtime-configure'") && stage.includes("status: 'started'")
  )
  const windowsReady = startupStages.findLastIndex(
    stage => stage.includes("step: 'windows-create'") && stage.includes("status: 'completed'")
  )
  assert.ok(
    runtimeConfiguration >= 0 && runtimeConfiguration < windowsReady,
    'Runtime preparation must overlap startup window loading'
  )
  const stages = startupStages.filter(stage => stage.includes("step: 'startup-splash-close'"))
  assert.ok(stages.length > 0, 'Startup must reach the usable renderer')
  const durationMs = Number(stages.at(-1).match(/elapsedMs:\s*(\d+)/)?.[1])
  assert.ok(Number.isFinite(durationMs) && durationMs < 5000, `${label}: ${durationMs}ms >= 5s`)
  return { label, durationMs }
}

export function createDesktopScenario({ resultDir, electronUserDataDirectory }) {
  const legacyRoot = join(resultDir, 'existing-smart-app')
  let restartDesktopApp
  let legacyManifestBytes
  let legacyDescriptor
  return {
    usesReleasePackageRuntimeAssets: true,
    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },
    async prepareApp({ appBinary }) {
      const catalog = JSON.parse(
        await readFile(join(packagedResourcesRoot(appBinary), 'harness-runtime', 'runtimes.json'))
      )
      const core = catalog.runtimes.find(runtime => runtime.role === 'core')
      assert.equal(core.dshVersion, LATEST_VERSION)
      assert.equal(core.directory, core.sourceFingerprint)
      const coreRoot = join(packagedResourcesRoot(appBinary), 'harness-runtime', core.directory)
      const dshPackage = join(coreRoot, 'node_modules', '@deepseek-ai', 'dsh')
      assert.equal(
        isAbsolute(await readlink(dshPackage)),
        false,
        'Packaged DSH must be relocatable'
      )
      assert.equal(relative(coreRoot, await realpath(dshPackage)).startsWith('..'), false)
      legacyDescriptor = catalog.runtimes.find(
        runtime => runtime.role === 'workbench' && runtime.dshVersion === LEGACY_VERSION
      )
      assert.equal(legacyDescriptor.bundled, false)
      await seedNativeDshProfile(electronUserDataDirectory)
      const manifest = await createSmartAppFixture(legacyRoot, LEGACY_ID, LEGACY_VERSION)
      legacyManifestBytes = await readFile(join(legacyRoot, 'plugin-manifest.json'), 'utf8')
      const registryRoot = join(electronUserDataDirectory, 'harness-apps')
      await mkdir(registryRoot, { recursive: true })
      await writeFile(
        join(registryRoot, 'installations.json'),
        JSON.stringify([
          {
            id: LEGACY_ID,
            manifest,
            packagePath: legacyRoot,
            sha256: '0'.repeat(64),
            modelKey: null,
            resident: false,
            runtimeVersion: null,
            state: 'installed',
            webUrl: null,
            error: null,
            source: 'managed',
          },
        ])
      )
    },
    async verify(control) {
      const durations = [await assertStartupBudget(control, resultDir, 'upgrade cold start')]
      await control.command(
        'waitFor',
        'body[data-native-dsh-provider-active][data-native-dsh-consumer-active]'
      )
      assert.equal(
        control.httpRequests.filter(request => request.pathname.startsWith('/dsh-runtime-assets/'))
          .length,
        0,
        'Wework startup must not download the legacy runtime'
      )
      const scaffold = await invoke(control, 'smartApps.createDirectory', {
        parentPath: resultDir,
        name: 'latest-scaffold',
        displayName: 'Latest scaffold',
        description: 'Latest runtime scaffold',
        template: 'web',
      })
      assert.equal(scaffold.manifest.requirements.dsh, LATEST_VERSION)
      const latestRoot = join(resultDir, 'latest-smart-app')
      await createSmartAppFixture(latestRoot, 'latest-smart-app', LATEST_VERSION)
      const latest = await invoke(control, 'smartApps.linkDirectory', { directoryPath: latestRoot })
      await assertRuntime(control, latest.id, LATEST_VERSION)
      await assertRuntime(control, LEGACY_ID, LEGACY_VERSION)
      const downloads = control.httpRequests.filter(
        request => request.pathname === `/dsh-runtime-assets/${legacyDescriptor.assetName}`
      )
      assert.equal(downloads.length, 1, 'The old runtime must download only when first requested')
      assert.ok(restartDesktopApp, 'The upgrade scenario requires a restart hook')
      await restartDesktopApp({
        appEnvironmentOverrides: { WEWORK_HARNESS_RUNTIME_BASE_URL: 'http://127.0.0.1:1/offline' },
      })
      durations.push(await assertStartupBudget(control, resultDir, 'cached warm start'))
      await assertRuntime(control, LEGACY_ID, LEGACY_VERSION)
      assert.equal(
        await readFile(join(legacyRoot, 'plugin-manifest.json'), 'utf8'),
        legacyManifestBytes
      )
      const templates = await verifySmartAppTemplates(control, resultDir)
      await writeFile(
        join(resultDir, 'dsh-runtime-upgrade.json'),
        JSON.stringify({ durations, downloads: downloads.length, templates }, null, 2)
      )
    },
  }
}
