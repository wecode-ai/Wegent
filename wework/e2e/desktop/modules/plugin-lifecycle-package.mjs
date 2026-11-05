import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commandOutputAsync, repoDir } from './shared.mjs'

// CI uses the ordinary lifecycle fixture. Local investigations can exercise the
// same assertions with an immutable installed package, without personal auth data.
export function lifecyclePluginSlug(fallback) {
  return process.env.WEWORK_E2E_LIFECYCLE_PACKAGE_ROOT?.trim() ? 'dingtalk' : fallback
}

export async function publishLifecycleRelease(cloud, resultDir, { slug, version, skills }) {
  const source = process.env.WEWORK_E2E_LIFECYCLE_PACKAGE_ROOT?.trim()
  if (!source) return cloud.publishPluginRelease({ slug, version, skills })
  const sourceManifest = JSON.parse(
    await readFile(join(source, '.codex-plugin/plugin.json'), 'utf8')
  )
  assert.equal(sourceManifest.name, 'dingtalk', 'Expected the real DingTalk package')
  assert.equal(slug, 'dingtalk')
  const packageRoot = join(resultDir, 'lifecycle-packages', `${slug}-${version}`)
  await cp(source, packageRoot, { recursive: true, errorOnExist: true, force: false })
  // Only the isolated copy gets a test version and an update marker. Runtime
  // scripts, bundled platform binaries and connector definitions remain intact.
  sourceManifest.version = version
  await writeFile(
    join(packageRoot, '.codex-plugin/plugin.json'),
    `${JSON.stringify(sourceManifest, null, 2)}\n`
  )
  for (const [name, marker] of Object.entries(skills ?? {})) {
    const path = join(packageRoot, 'skills', name)
    await mkdir(path, { recursive: true })
    await writeFile(
      join(path, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${marker}\n---\n\n${marker}\n`
    )
  }
  const prebuilt = JSON.parse(
    await commandOutputAsync(
      'uv',
      [
        'run',
        'python',
        join(repoDir, 'wework/e2e/desktop/fixtures/lifecycle-package.py'),
        packageRoot,
      ],
      { cwd: join(repoDir, 'backend') }
    )
  )
  return cloud.publishPluginRelease({ slug, version, prebuilt })
}
