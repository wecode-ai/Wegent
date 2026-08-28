#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { compareWeworkVersions } from './update-channel-manifests.mjs'

const RELEASE_TAG_PATTERN = /^wework-v(\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?)$/

const COMPONENT_PATH_PREFIXES = [
  'executor/',
  'packages/chat-core/',
  'wework/dsh/',
  'wework/harness-runtime/',
  'wework/src/',
]

const COMPONENT_PATHS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'wework/.prettierrc.json',
  'wework/codex-binaries.lock.json',
  'wework/components.json',
  'wework/eslint.config.js',
  'wework/index.html',
  'wework/package.json',
  'wework/postcss.config.js',
  'wework/tailwind.config.js',
  'wework/tsconfig.app.json',
  'wework/tsconfig.json',
  'wework/tsconfig.node.json',
  'wework/vite.config.ts',
])

const COMPONENT_RESOURCE_PREFIXES = [
  'wework/resources/binaries/codex/',
  'wework/resources/binaries/dws-',
  'wework/resources/bundled-harness-runtime/',
  'wework/resources/bundled-plugins/',
]

export function resolveCurrentRelease(tags, channel) {
  if (channel !== 'stable' && channel !== 'beta') {
    throw new Error(`Unsupported Wework release channel: ${channel}`)
  }

  const candidates = tags
    .map(tag => {
      const match = RELEASE_TAG_PATTERN.exec(tag)
      return match ? { tag, version: match[1] } : null
    })
    .filter(candidate => candidate !== null)
    .filter(candidate => channel === 'beta' || !candidate.version.includes('-beta.'))
    .toSorted((left, right) => compareWeworkVersions(right.version, left.version))

  return candidates[0] ?? null
}

export function classifyDesktopChanges(changedPaths) {
  let componentChanged = false

  for (const path of changedPaths) {
    if (isIgnoredPath(path)) continue
    if (!isWeworkReleasePath(path)) continue
    if (isComponentPath(path)) {
      componentChanged = true
      continue
    }
    return 'full'
  }

  return componentChanged ? 'component' : 'none'
}

export function planDesktopRelease({
  tags,
  changedPaths,
  channel,
  candidateVersion,
  candidateTag,
  candidatePrerelease,
  publishRelease,
  currentRelease,
  sourceSha = '',
  forceFull = false,
}) {
  if (!publishRelease || forceFull) {
    return {
      kind: 'full',
      version: candidateVersion,
      releaseTag: candidateTag,
      prerelease: candidatePrerelease,
      baseTag: '',
    }
  }

  const current = currentRelease ?? resolveCurrentRelease(tags, channel)
  if (!current) {
    return {
      kind: 'full',
      version: candidateVersion,
      releaseTag: candidateTag,
      prerelease: candidatePrerelease,
      baseTag: '',
    }
  }

  const kind = classifyDesktopChanges(changedPaths)
  if (kind === 'full') {
    return {
      kind,
      version: candidateVersion,
      releaseTag: candidateTag,
      prerelease: candidatePrerelease,
      baseTag: current.tag,
    }
  }

  if (!/^[0-9a-f]{40,64}$/.test(sourceSha)) {
    throw new Error(`A full source SHA is required for a component release: ${sourceSha}`)
  }
  return {
    kind,
    version: current.version,
    releaseTag: `wework-v${current.version}-runtime.${sourceSha.slice(0, 12)}`,
    prerelease: current.version.includes('-beta.'),
    baseTag: current.sourceRef || current.tag,
  }
}

function isWeworkReleasePath(path) {
  return (
    path === '.github/workflows/wework-app.yml' ||
    path === 'package.json' ||
    path === 'pnpm-lock.yaml' ||
    path === 'pnpm-workspace.yaml' ||
    path.startsWith('executor/') ||
    path.startsWith('packages/chat-core/') ||
    path.startsWith('patches/') ||
    path.startsWith('wework/')
  )
}

function isIgnoredPath(path) {
  if (
    path === 'wework/.gitignore' ||
    path === 'wework/AGENTS.md' ||
    path === 'wework/DESIGN.md' ||
    path === 'wework/README.md' ||
    path === 'wework/design-qa.md' ||
    path === 'wework/playwright.config.ts' ||
    path.startsWith('wework/e2e/')
  ) {
    return true
  }
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
}

function isComponentPath(path) {
  if (COMPONENT_PATHS.has(path)) return true
  if (COMPONENT_PATH_PREFIXES.some(prefix => path.startsWith(prefix))) return true
  return COMPONENT_RESOURCE_PREFIXES.some(prefix => path.startsWith(prefix))
}

function readTags() {
  return execFileSync('git', ['tag', '--list', 'wework-v*'], {
    encoding: 'utf8',
  })
    .split('\n')
    .map(tag => tag.trim())
    .filter(Boolean)
}

function changedPaths(baseRef, fallbackRef = '') {
  for (const reference of [baseRef, fallbackRef]) {
    if (!reference) continue
    try {
      return execFileSync('git', ['diff', '--name-only', `${reference}..HEAD`], {
        encoding: 'utf8',
      })
        .split('\n')
        .map(path => path.trim())
        .filter(Boolean)
    } catch {
      continue
    }
  }
  return null
}

async function main() {
  const channel = process.env.RELEASE_CHANNEL
  const candidateVersion = process.env.CANDIDATE_VERSION
  const candidateTag = process.env.CANDIDATE_TAG
  const candidatePrerelease = process.env.CANDIDATE_PRERELEASE === 'true'
  const publishRelease = process.env.PUBLISH_RELEASE === 'true'
  const currentAppVersion = process.env.CURRENT_APP_VERSION?.trim()
  const currentSourceRef = process.env.CURRENT_SOURCE_REF?.trim()
  if (!channel) throw new Error('RELEASE_CHANNEL is required')
  if (!candidateVersion) throw new Error('CANDIDATE_VERSION is required')
  if (!candidateTag) throw new Error('CANDIDATE_TAG is required')

  const tags = readTags()
  const current = currentAppVersion
    ? {
        tag: `wework-v${currentAppVersion}`,
        version: currentAppVersion,
        sourceRef: currentSourceRef,
      }
    : resolveCurrentRelease(tags, channel)
  const paths = changedPaths(currentSourceRef, current?.tag)
  const sourceSha =
    process.env.GITHUB_SHA?.trim() ||
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const plan = planDesktopRelease({
    tags,
    changedPaths: paths ?? [],
    channel,
    candidateVersion,
    candidateTag,
    candidatePrerelease,
    publishRelease,
    currentRelease: current,
    sourceSha,
    forceFull:
      paths === null || (process.env.GITHUB_REF?.startsWith('refs/tags/wework-v') ?? false),
  })
  const output = [
    `kind=${plan.kind}`,
    `value=${plan.version}`,
    `release_tag=${plan.releaseTag}`,
    `prerelease=${plan.prerelease}`,
    `base_tag=${plan.baseTag}`,
    '',
  ].join('\n')

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, output, 'utf8')
  } else {
    process.stdout.write(output)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
