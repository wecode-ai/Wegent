import assert from 'node:assert/strict'

// Chromium verbose logging is opt-in per run: it records why child processes
// (network service, zygote) exit, which is the evidence needed to attribute
// unexplained "Network service crashed" events (#4006). The log volume is
// significant, so CI keeps it off unless a diagnostic run requests it.
export function chromiumVerboseLoggingArguments(
  rawValue = process.env.WEWORK_E2E_CHROMIUM_VERBOSE
) {
  if (rawValue === undefined || rawValue === '' || rawValue === 'false' || rawValue === '0') {
    return []
  }
  assert.match(
    rawValue,
    /^(?:true|[1-9])$/,
    'WEWORK_E2E_CHROMIUM_VERBOSE must be a Chromium verbosity level (1-9), "true" (level 1), or empty'
  )
  const level = rawValue === 'true' ? '1' : rawValue
  return ['--enable-logging=stderr', `--v=${level}`]
}

export function resolveElectronLaunchArguments({
  platform = process.platform,
  getuid = process.getuid,
  isolatedXvfb = process.env.WEWORK_E2E_ISOLATED_XVFB,
  extraArguments = [],
  verboseLoggingArguments = chromiumVerboseLoggingArguments(),
} = {}) {
  assert.ok(Array.isArray(extraArguments), 'Electron E2E launch arguments must be an array')
  for (const argument of extraArguments) {
    assert.match(argument, /^--[^=]+(?:=.*)?$/, `Invalid Electron E2E launch argument: ${argument}`)
  }
  assert.ok(
    Array.isArray(verboseLoggingArguments),
    'Electron E2E verbose logging arguments must be an array'
  )

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
    return [
      '--disable-features=' + [...disabledFeatures].join(','),
      ...verboseLoggingArguments,
      ...scenarioArguments,
    ]
  }
  return [...argumentsForPlatform, ...verboseLoggingArguments, ...extraArguments]
}
