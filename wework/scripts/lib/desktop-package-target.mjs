const targetByPlatformAndArchitecture = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
}

function normalizedPlatform(value) {
  return (
    {
      macos: 'darwin',
      windows: 'win32',
    }[value] ?? value
  )
}

export function resolveDesktopPackageTargets(
  environment,
  runtime = { platform: process.platform, arch: process.arch }
) {
  const explicitTargets = {
    cargoTarget: environment.CARGO_BUILD_TARGET?.trim(),
    codexTarget: environment.WEWORK_CODEX_TARGET?.trim(),
    dwsTarget: environment.WEWORK_DWS_TARGET?.trim(),
  }
  if (Object.values(explicitTargets).every(Boolean)) return explicitTargets

  const platform = normalizedPlatform(
    environment.WEWORK_RELEASE_PLATFORM?.trim() || runtime.platform
  )
  const arch = environment.WEWORK_RELEASE_ARCH?.trim() || runtime.arch
  const derivedTarget = targetByPlatformAndArchitecture[`${platform}-${arch}`]
  if (!derivedTarget) {
    throw new Error(`Unsupported Wework package target: ${platform}-${arch}`)
  }

  return {
    cargoTarget: explicitTargets.cargoTarget || derivedTarget,
    codexTarget: explicitTargets.codexTarget || derivedTarget,
    dwsTarget: explicitTargets.dwsTarget || derivedTarget,
  }
}

export function targetExecutableName(target, name) {
  return target.includes('windows') ? `${name}.exe` : name
}
