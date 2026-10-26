import assert from 'node:assert/strict'
import { readFile, readdir, stat, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  extractZipFixture,
  createZipFixture,
  extractSingleRootZipFixture,
} from './zip-fixtures.mjs'

export const INSTALLATION_ID = 'dsh-e2e-smoke'
export const IMPORTED_INSTALLATION_ID = 'dsh-e2e-smoke-imported'
export const LEGACY_INSTALLATION_ID = 'dsh-e2e-legacy'
export const CREATED_INSTALLATION_ID = 'dsh-e2e-created'
export const APP_ROUTE = `/app/harness-${INSTALLATION_ID}`
export const MODEL_LABEL = 'Desktop E2E Chat'
export const RECIPIENT_NAME = 'smart-app-e2e-recipient'
export const STRANGER_NAME = 'smart-app-e2e-stranger'
export const USER_PASSWORD = 'smart-app-e2e-password'

export async function requestJson(baseUrl, token, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${pathname} failed with HTTP ${response.status}: ${text}`
  )
  return body
}

export async function setExperimentalFeatures(control, enabled, uiTimeoutMs) {
  await control.command('navigate', 'body', { value: '/settings/general' })
  await control.command('waitFor', '[data-testid="general-experimental-features-toggle"]', {
    enabled: true,
    stableMs: 300,
    timeoutMs: uiTimeoutMs,
  })
  const expected = String(enabled)
  if (
    (await control.command('getAttribute', '[data-testid="general-experimental-features-toggle"]', {
      value: 'aria-checked',
    })) !== expected
  ) {
    await control.command('click', '[data-testid="general-experimental-features-toggle"]')
  }
  await control.command(
    'waitFor',
    `[data-testid="general-experimental-features-toggle"][aria-checked="${expected}"]`,
    {
      stableMs: 300,
      timeoutMs: uiTimeoutMs,
    }
  )
}

export async function waitForElementCount(control, selector, expected, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (Number(await control.command('getElementCount', selector)) === expected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

export async function waitForManifestPlugin(manifestPath, pluginSpec, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (manifest.plugins?.some(plugin => plugin.spec === pluginSpec)) return manifest
    } catch {
      // The manifest can be temporarily unavailable while the package is being updated.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Smart app manifest did not include ${pluginSpec}`)
}

export async function exportedPackages(downloadsPath) {
  return new Set(
    await readdir(downloadsPath)
      .then(entries => entries.filter(entry => entry.endsWith('.zip')))
      .catch(() => [])
  )
}

export async function waitForNewExport(downloadsPath, before, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const entries = await exportedPackages(downloadsPath)
    const added = [...entries].find(entry => !before.has(entry))
    if (added) return join(downloadsPath, added)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Smart app export success did not create a ZIP in Downloads')
}

export async function waitForMissing(control, selector, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (Number(await control.command('getElementCount', selector)) === 0) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for "${selector}" to disappear`)
}

export async function assertExportedPackage({
  archivePath,
  expectedName,
  expectedVersion,
  extractionPath,
}) {
  assert.ok((await stat(archivePath)).size > 0, 'The exported Smart app ZIP was empty')
  await extractZipFixture(archivePath, extractionPath)
  const manifest = JSON.parse(await readFile(join(extractionPath, 'plugin-manifest.json'), 'utf8'))
  assert.equal(manifest.name, expectedName)
  assert.equal(manifest.version, expectedVersion)
  await rm(archivePath)
}

export async function createHarnessPackage(
  resultDir,
  installationId,
  dshVersion,
  { archiveName = installationId, version = '0.1.0' } = {}
) {
  const packagePath = join(resultDir, `${archiveName}.zip`)
  const root = `harness-e2e-plugin-${installationId}`
  await createZipFixture(packagePath, {
    [`${root}/PLUGIN.md`]: '# Harness desktop E2E\n',
    [`${root}/INSTALL.zh-CN.md`]: '# 安装\n',
    [`${root}/plugin-manifest.json`]: JSON.stringify(
      {
        name: installationId,
        displayName: `DSH E2E Smoke ${dshVersion}`,
        version,
        type: 'deepseek-harness-plugin-bundle',
        description: 'Desktop E2E Harness smoke package',
        entry: {
          installPackage: 'packages/bundle/smoke-app',
          profile: 'smoke',
          webUrl: 'http://127.0.0.1:3080/',
        },
        requirements: {
          dsh: dshVersion,
          node: '>=22',
        },
        defaultModel: {
          provider: 'fixture',
          model: 'fixture',
          configPath: '$DSH_HOME/profiles/smoke/cordis.patch.yml',
        },
      },
      null,
      2
    ),
    [`${root}/packages/bundle/smoke-app/package.json`]: JSON.stringify(
      {
        name: '@wework/dsh-e2e-smoke',
        version: '0.1.0',
        type: 'module',
        main: 'lib/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2
    ),
    [`${root}/packages/bundle/smoke-app/lib/index.js`]: 'export default {}\n',
    [`${root}/packages/bundle/smoke-app/cordis.patch.yml`]:
      '- id: ui-model-selection\n  config:\n    provider: fixture\n    model: fixture\n',
  })
  return packagePath
}

export async function createOfficialSource(resultDir, packagePath) {
  const source = join(resultDir, 'official-smart-app')
  await extractSingleRootZipFixture(packagePath, source)
  await writeFile(
    join(source, 'icon.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    )
  )
  await writeFile(
    join(source, 'smart-app-marketplace.json'),
    JSON.stringify({
      summary: 'Official desktop E2E Smart app',
      descriptionMd:
        '# DSH E2E Smoke 0.1.0-rc.8\n\n面向现场演示的智能资料处理应用。上传文件后，可以选择工作表与文本列并完成分类。\n\n## 主要能力\n\n- 自动检查文件结构和数据预览\n- 支持自定义分类标签和兜底分类\n- 实时展示处理进度与失败行\n- 保留原始文件并下载处理结果\n\n## 演示建议\n\n准备一个包含文本列的小型文件，使用正向、负向和中性作为标签，快速展示完整流程。',
      tags: ['data_analysis'],
      icon: 'icon.png',
      releaseNotes: 'Initial official E2E release',
      extensions: {
        schemaVersion: 1,
        'com.weibo.internal': { businessOwner: 'desktop-e2e' },
      },
      releaseExtensions: {
        'com.weibo.build': { pipeline: 'desktop-e2e-official' },
      },
    })
  )
  return source
}

export async function createLocalDshPlugin(resultDir) {
  const pluginPath = join(resultDir, 'local-dsh-plugin')
  await mkdir(pluginPath, { recursive: true })
  await writeFile(
    join(pluginPath, 'package.json'),
    JSON.stringify(
      {
        name: '@wework-e2e/local-dsh-plugin',
        version: '0.1.0',
        type: 'module',
        files: ['cordis.patch.yml'],
        dependencies: {
          'node-pty': '1.1.0',
        },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2
    )
  )
  await writeFile(join(pluginPath, 'cordis.patch.yml'), '[]\n')
  return pluginPath
}
