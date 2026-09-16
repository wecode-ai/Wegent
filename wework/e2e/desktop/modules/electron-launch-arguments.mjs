import assert from 'node:assert/strict'

export function resolveElectronLaunchArguments({
  platform = process.platform,
  getuid = process.getuid,
  isolatedXvfb = process.env.WEWORK_E2E_ISOLATED_XVFB,
  extraArguments = [],
} = {}) {
  assert.ok(Array.isArray(extraArguments), 'Electron E2E launch arguments must be an array')
  for (const argument of extraArguments) {
    assert.match(argument, /^--[^=]+(?:=.*)?$/, `Invalid Electron E2E launch argument: ${argument}`)
  }

  const argumentsForPlatform = []
  if (platform === 'linux' && typeof getuid === 'function' && getuid() === 0) {
    assert.equal(
      isolatedXvfb,
      'true',
      'Root Electron E2E may disable the Chromium sandbox only inside isolated Xvfb'
    )
    argumentsForPlatform.push(
      '--no-sandbox',
      '--disable-gpu',
      '--in-process-gpu',
      '--disable-dev-shm-usage'
    )
  }
  return [...argumentsForPlatform, ...extraArguments]
}
