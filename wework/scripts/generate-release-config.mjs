#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

const baseConfigPath = requiredEnvironment('BASE_CONFIG')
const outputConfigPath = requiredEnvironment('CONFIG_OVERRIDE')
const baseConfig = JSON.parse(await readFile(baseConfigPath, 'utf8'))
const baseResources = baseConfig.bundle?.resources

if (!Array.isArray(baseResources)) {
  throw new Error(`Base Tauri config has no bundle.resources array: ${baseConfigPath}`)
}

function codexTargetsForBuildTarget(buildTarget) {
  if (!buildTarget) return []
  if (buildTarget === 'universal-apple-darwin') {
    return ['aarch64-apple-darwin', 'x86_64-apple-darwin']
  }
  return [buildTarget]
}

const codexTargets = codexTargetsForBuildTarget(process.env.CODEX_TARGET?.trim())
const resources =
  codexTargets.length === 0
    ? baseResources
    : baseResources.flatMap(resource =>
        resource === 'binaries/codex/**/*'
          ? [
              ...codexTargets.map(target => `binaries/codex/${target}/**/*`),
              'binaries/codex/legal/**/*',
            ]
          : [resource]
      )

const config = {
  version: requiredEnvironment('VERSION'),
  bundle: {
    createUpdaterArtifacts: true,
    resources,
  },
  plugins: {
    updater: {
      endpoints: [requiredEnvironment('UPDATER_ENDPOINT')],
      pubkey: requiredEnvironment('UPDATER_PUBKEY'),
    },
  },
}

const identity = process.env.SIGNING_IDENTITY?.trim()
if (identity) {
  config.bundle.macOS = {
    signingIdentity: identity,
    hardenedRuntime: true,
  }
}

if (process.env.ENABLE_INSECURE_TRANSPORT === 'true') {
  config.plugins.updater.dangerousInsecureTransportProtocol = true
}

await writeFile(outputConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
