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
  if (platform === 'win32') {
    // crbug.com/572515601: Windows random allocation can fail despite free loopback ports.
    const disabledFeatures = new Set(['TcpPortRandomizationWin'])
    const scenarioArguments = extraArguments.filter(argument => {
      if (!argument.startsWith('--disable-features=')) return true
      for (const feature of argument.slice('--disable-features='.length).split(',')) {
        if (feature) disabledFeatures.add(feature)
      }
      return false
    })
    return ['--disable-features=' + [...disabledFeatures].join(','), ...scenarioArguments]
  }
  return [...argumentsForPlatform, ...extraArguments]
}
