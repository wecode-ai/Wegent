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
const resources = baseConfig.bundle?.resources

if (!Array.isArray(resources)) {
  throw new Error(`Base Tauri config has no bundle.resources array: ${baseConfigPath}`)
}

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
