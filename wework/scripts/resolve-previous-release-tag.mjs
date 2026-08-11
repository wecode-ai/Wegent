#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { compareWeworkVersions } from './update-channel-manifests.mjs'

const RELEASE_TAG_PATTERN = /^wework-v(\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?)$/

export function resolvePreviousReleaseTag({ tags, releaseTag, releaseChannel }) {
  if (releaseChannel !== 'stable' && releaseChannel !== 'beta') {
    throw new Error(`Unsupported Wework release channel: ${releaseChannel}`)
  }

  const releaseMatch = RELEASE_TAG_PATTERN.exec(releaseTag)
  if (!releaseMatch) {
    throw new Error(`Unsupported Wework release tag: ${releaseTag}`)
  }

  const releaseVersion = releaseMatch[1]
  const candidates = tags
    .map(tag => {
      const match = RELEASE_TAG_PATTERN.exec(tag)
      return match ? { tag, version: match[1] } : null
    })
    .filter(candidate => candidate !== null)
    .filter(candidate => candidate.tag !== releaseTag)
    .filter(candidate => releaseChannel === 'beta' || !candidate.version.includes('-beta.'))
    .filter(candidate => compareWeworkVersions(candidate.version, releaseVersion) < 0)

  candidates.sort((left, right) => compareWeworkVersions(right.version, left.version))
  return candidates[0]?.tag ?? ''
}

function readTags() {
  return execFileSync('git', ['tag', '--list', 'wework-v*'], {
    encoding: 'utf8',
  })
    .split('\n')
    .map(tag => tag.trim())
    .filter(Boolean)
}

function main() {
  const releaseTag = process.env.RELEASE_TAG
  const releaseChannel = process.env.RELEASE_CHANNEL
  if (!releaseTag) throw new Error('RELEASE_TAG is required')
  if (!releaseChannel) throw new Error('RELEASE_CHANNEL is required')

  process.stdout.write(
    resolvePreviousReleaseTag({
      tags: readTags(),
      releaseTag,
      releaseChannel,
    })
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}
