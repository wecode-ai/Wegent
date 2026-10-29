import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const hash = value => createHash('sha256').update(value).digest('hex')

export function windowsBuildKey({ cwd = process.cwd(), toolchain }) {
  const manifest = execFileSync(
    'git',
    [
      'ls-files',
      '-s',
      '--',
      '.github/actions/build-wework-windows-e2e',
      '.github/actions/setup-node-workspace',
      '.github/actions/setup-sccache',
      '.github/scripts/wework-windows-e2e-build-key.mjs',
      '.cargo',
      '.npmrc',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'packages',
      'frontend/package.json',
      'executor',
      'backend-rs',
      'shared/assets',
      'wework',
      ':(exclude)wework/e2e/**',
      ':(exclude)wework/test-results/**',
    ],
    { cwd, encoding: 'utf8' }
  )
  const toolchainDigest = hash(toolchain)
  return {
    key: `Windows-wework-desktop-e2e-v1-${hash(`${toolchainDigest}\n${manifest}`)}`,
    toolchain: toolchainDigest,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = windowsBuildKey({
    toolchain: JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      imageOS: process.env.ImageOS,
      imageVersion: process.env.ImageVersion,
      rust: execFileSync('rustc', ['-vV'], { encoding: 'utf8' }),
      executorProfile: 'debug',
    }),
  })
  for (const [name, value] of Object.entries(result)) console.log(`${name}=${value}`)
}
