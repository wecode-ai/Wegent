const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const DECISION_UPSTREAM_PATH = '/v1/decisions'
const MAX_DECISION_MODEL_LENGTH = 128
const DECISION_MODEL_PATTERN = /^[A-Za-z0-9._/:-]+$/

const DEFAULT_IDENTITY = Object.freeze({
  productName: 'WeWork',
  identifier: 'io.wecode.wework',
  executableName: 'WeWork',
  packageName: 'io.wecode.wework',
  executorNamespace: null,
  backendUrl: null,
  socketUrl: null,
  decisionUpstreamUrl: null,
  decisionDefaultModel: null,
})

function resolveBuildIdentity(environment = process.env) {
  const configuredPath = environment.WEWORK_BRAND_CONFIG?.trim()
  if (!configuredPath) return DEFAULT_IDENTITY

  const path = resolve(configuredPath)
  let configured
  try {
    configured = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid Wework brand config ${path}: ${error.message}`)
  }
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new Error(`Wework brand config must be an object: ${path}`)
  }

  const productName = requiredText(configured.productName, 'productName', path)
  const identifier = requiredText(configured.identifier, 'identifier', path)
  const executableName =
    optionalText(configured.mainBinaryName, 'mainBinaryName', path) || productName
  const backendUrl = optionalUrl(configured.backendUrl, 'backendUrl', path, ['http:', 'https:'])
  const socketUrl = optionalUrl(configured.socketUrl, 'socketUrl', path, [
    'http:',
    'https:',
    'ws:',
    'wss:',
  ])
  const decisionUpstreamUrl = optionalDecisionUpstreamUrl(configured.decisionUpstreamUrl, path)
  const decisionDefaultModel = optionalDecisionDefaultModel(configured.decisionDefaultModel, path)

  if (!/^[A-Za-z0-9.-]+$/.test(identifier)) {
    throw new Error(
      `Wework brand identifier may only contain letters, numbers, '.' and '-': ${path}`
    )
  }
  validateFileName(productName, 'productName', path)
  validateFileName(executableName, 'mainBinaryName', path)
  if ((decisionUpstreamUrl === null) !== (decisionDefaultModel === null)) {
    throw new Error(
      `Wework brand config decisionUpstreamUrl and decisionDefaultModel must be configured together: ${path}`
    )
  }

  return Object.freeze({
    productName,
    identifier,
    executableName,
    packageName: identifier,
    executorNamespace: identifier,
    backendUrl,
    socketUrl,
    decisionUpstreamUrl,
    decisionDefaultModel,
  })
}

function requiredText(value, field, path) {
  const text = optionalText(value, field, path)
  if (!text) throw new Error(`Wework brand config is missing ${field}: ${path}`)
  return text
}

function optionalText(value, field, path) {
  if (value === undefined) return null
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Wework brand config ${field} must be non-empty text: ${path}`)
  }
  return value.trim()
}

function optionalUrl(value, field, path, protocols) {
  const text = optionalText(value, field, path)
  if (!text) return null
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`Wework brand config ${field} must be an absolute URL: ${path}`)
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`Wework brand config ${field} must use ${protocols.join(' or ')}: ${path}`)
  }
  if (url.username || url.password) {
    throw new Error(`Wework brand config ${field} may not contain credentials: ${path}`)
  }
  return text.replace(/\/+$/, '')
}

function optionalDecisionUpstreamUrl(value, path) {
  if (value === undefined) return null
  const invalid = () =>
    new Error(
      `Wework brand config decisionUpstreamUrl must be an absolute https URL with path ${DECISION_UPSTREAM_PATH}: ${path}`
    )
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid()
  }

  const text = value.trim()
  let url
  try {
    url = new URL(text)
  } catch {
    throw invalid()
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    text.includes('?') ||
    text.includes('#') ||
    url.search ||
    url.hash ||
    url.pathname !== DECISION_UPSTREAM_PATH
  ) {
    throw invalid()
  }
  return text
}

function optionalDecisionDefaultModel(value, path) {
  if (value === undefined) return null
  if (typeof value !== 'string') {
    throw new Error(
      `Wework brand config decisionDefaultModel must be a valid model identifier of at most ${MAX_DECISION_MODEL_LENGTH} characters: ${path}`
    )
  }

  const text = value.trim()
  if (!text || text.length > MAX_DECISION_MODEL_LENGTH || !DECISION_MODEL_PATTERN.test(text)) {
    throw new Error(
      `Wework brand config decisionDefaultModel must be a valid model identifier of at most ${MAX_DECISION_MODEL_LENGTH} characters: ${path}`
    )
  }
  return text
}

function validateFileName(value, field, path) {
  if (value === '.' || value === '..' || /[/\\\0]/.test(value)) {
    throw new Error(`Wework brand config ${field} is not a safe file name: ${path}`)
  }
}

module.exports = {
  DEFAULT_IDENTITY,
  resolveBuildIdentity,
}
