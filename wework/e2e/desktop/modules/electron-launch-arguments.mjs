import assert from 'node:assert/strict'

export function resolveElectronLaunchArguments({
  platform = process.platform,
  getuid = process.getuid,
  isolatedXvfb = process.env.WEWORK_E2E_ISOLATED_XVFB,
} = {}) {
  if (platform !== 'linux' || typeof getuid !== 'function' || getuid() !== 0) {
    return []
  }

  assert.equal(
    isolatedXvfb,
    'true',
    'Root Electron E2E may disable the Chromium sandbox only inside isolated Xvfb'
  )
  return ['--no-sandbox', '--disable-gpu', '--in-process-gpu', '--disable-dev-shm-usage']
}
