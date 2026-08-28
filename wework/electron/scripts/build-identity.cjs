const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const DEFAULT_IDENTITY = Object.freeze({
  productName: 'WeWork',
  identifier: 'io.wecode.wework',
  executableName: 'WeWork',
  executorNamespace: null,
  backendUrl: null,
  socketUrl: null,
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

  if (!/^[A-Za-z0-9.-]+$/.test(identifier)) {
    throw new Error(
      `Wework brand identifier may only contain letters, numbers, '.' and '-': ${path}`
    )
  }
  validateFileName(productName, 'productName', path)
  validateFileName(executableName, 'mainBinaryName', path)

  return Object.freeze({
    productName,
    identifier,
    executableName,
    executorNamespace: identifier,
    backendUrl,
    socketUrl,
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

function validateFileName(value, field, path) {
  if (value === '.' || value === '..' || /[/\\\0]/.test(value)) {
    throw new Error(`Wework brand config ${field} is not a safe file name: ${path}`)
  }
}

module.exports = {
  DEFAULT_IDENTITY,
  resolveBuildIdentity,
}
