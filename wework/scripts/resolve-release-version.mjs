#!/usr/bin/env node

import { appendFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { compareWeworkVersions, parseWeworkVersion } from './update-channel-manifests.mjs'

const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const BETA_VERSION_PATTERN = /^\d+\.\d+\.\d+-beta\.[1-9]\d*$/

function validateStableVersion(version) {
  if (!STABLE_VERSION_PATTERN.test(version)) {
    throw new Error(
      `Invalid stable Wework version '${version}'. Expected MAJOR.MINOR.PATCH, for example 1.2.3.`
    )
  }
}

function validateBetaVersion(version) {
  if (!BETA_VERSION_PATTERN.test(version)) {
    throw new Error(
      `Invalid Beta Wework version '${version}'. Expected MAJOR.MINOR.PATCH-beta.NUMBER, for example 1.2.4-beta.1.`
    )
  }
}

function latestVersion(versions) {
  return versions.toSorted((left, right) => compareWeworkVersions(right, left))[0]
}

function bumpPatch(version) {
  const [major, minor, patch] = parseWeworkVersion(version)
  return `${major}.${minor}.${patch + 1}`
}

function nextStableVersion(tags) {
  const stableVersions = tags
    .filter(tag => /^wework-v\d+\.\d+\.\d+$/.test(tag))
    .map(tag => tag.slice('wework-v'.length))
  return stableVersions.length ? bumpPatch(latestVersion(stableVersions)) : '0.0.1'
}

function nextBetaVersion(tags) {
  const betaVersions = tags
    .filter(tag => /^wework-v\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(tag))
    .map(tag => tag.slice('wework-v'.length))

  const nextStable = nextStableVersion(tags)
  if (!betaVersions.length) return `${nextStable}-beta.1`

  const latestBeta = latestVersion(betaVersions)
  const [betaBase, betaNumber] = latestBeta.split('-beta.')
  if (compareWeworkVersions(betaBase, nextStable) >= 0) {
    return `${betaBase}-beta.${Number(betaNumber) + 1}`
  }
  return `${nextStable}-beta.1`
}

export function resolveReleaseVersion({
  tags,
  inputChannel = 'stable',
  inputVersion = '',
  githubRef = '',
  githubRefName = '',
  publishRelease = false,
}) {
  if (githubRef.startsWith('refs/tags/wework-v')) {
    const version = githubRefName.slice('wework-v'.length)
    const channel = version.includes('-beta.') ? 'beta' : 'stable'
    if (channel === 'beta') validateBetaVersion(version)
    else validateStableVersion(version)
    return {
      version,
      channel,
      releaseTag: githubRefName,
      prerelease: channel === 'beta',
      publishRelease: true,
    }
  }

  if (inputChannel !== 'stable' && inputChannel !== 'beta') {
    throw new Error(`Invalid Wework release channel '${inputChannel}'.`)
  }

  let version
  if (inputChannel === 'beta') {
    version = nextBetaVersion(tags)
  } else if (inputVersion) {
    version = inputVersion.replace(/^v/, '')
    validateStableVersion(version)
  } else {
    version = nextStableVersion(tags)
  }

  return {
    version,
    channel: inputChannel,
    releaseTag: `wework-v${version}`,
    prerelease: inputChannel === 'beta',
    publishRelease,
  }
}

function readTags() {
  const output = execFileSync('git', ['tag', '--list', 'wework-v*'], {
    encoding: 'utf8',
  })
  return output
    .split('\n')
    .map(tag => tag.trim())
    .filter(Boolean)
}

async function main() {
  const result = resolveReleaseVersion({
    tags: readTags(),
    inputChannel: process.env.INPUT_CHANNEL || 'stable',
    inputVersion: process.env.INPUT_VERSION || '',
    githubRef: process.env.GITHUB_REF || '',
    githubRefName: process.env.GITHUB_REF_NAME || '',
    publishRelease: process.env.PUBLISH_RELEASE === 'true',
  })
  const output = [
    `value=${result.version}`,
    `release_tag=${result.releaseTag}`,
    `channel=${result.channel}`,
    `prerelease=${result.prerelease}`,
    `publish_release=${result.publishRelease}`,
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
