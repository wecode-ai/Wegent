import { describe, expect, test } from 'vitest'

import { resolveDesktopPackageTargets, targetExecutableName } from './desktop-package-target.mjs'

describe('resolveDesktopPackageTargets', () => {
  test.each([
    ['macos', 'arm64', 'aarch64-apple-darwin'],
    ['darwin', 'x64', 'x86_64-apple-darwin'],
    ['linux', 'arm64', 'aarch64-unknown-linux-gnu'],
    ['linux', 'x64', 'x86_64-unknown-linux-gnu'],
    ['windows', 'x64', 'x86_64-pc-windows-msvc'],
    ['win32', 'x64', 'x86_64-pc-windows-msvc'],
  ])('derives %s/%s package sidecars as %s', (platform, arch, target) => {
    expect(
      resolveDesktopPackageTargets({
        WEWORK_RELEASE_ARCH: arch,
        WEWORK_RELEASE_PLATFORM: platform,
      })
    ).toEqual({
      cargoTarget: target,
      codexTarget: target,
      dwsTarget: target,
    })
  })

  test('preserves explicit package targets', () => {
    expect(
      resolveDesktopPackageTargets(
        {
          CARGO_BUILD_TARGET: 'cargo-explicit',
          WEWORK_CODEX_TARGET: 'codex-explicit',
          WEWORK_DWS_TARGET: 'dws-explicit',
          WEWORK_RELEASE_ARCH: 'arm64',
          WEWORK_RELEASE_PLATFORM: 'macos',
        },
        { platform: 'linux', arch: 'x64' }
      )
    ).toEqual({
      cargoTarget: 'cargo-explicit',
      codexTarget: 'codex-explicit',
      dwsTarget: 'dws-explicit',
    })
  })

  test('fills only missing targets from the release target', () => {
    expect(
      resolveDesktopPackageTargets(
        {
          WEWORK_CODEX_TARGET: 'codex-explicit',
          WEWORK_RELEASE_ARCH: 'x64',
          WEWORK_RELEASE_PLATFORM: 'linux',
        },
        { platform: 'darwin', arch: 'arm64' }
      )
    ).toEqual({
      cargoTarget: 'x86_64-unknown-linux-gnu',
      codexTarget: 'codex-explicit',
      dwsTarget: 'x86_64-unknown-linux-gnu',
    })
  })

  test('uses the runtime target when release variables are absent', () => {
    expect(resolveDesktopPackageTargets({}, { platform: 'darwin', arch: 'arm64' })).toEqual({
      cargoTarget: 'aarch64-apple-darwin',
      codexTarget: 'aarch64-apple-darwin',
      dwsTarget: 'aarch64-apple-darwin',
    })
  })

  test('rejects unsupported package targets', () => {
    expect(() =>
      resolveDesktopPackageTargets({
        WEWORK_RELEASE_ARCH: 'arm64',
        WEWORK_RELEASE_PLATFORM: 'windows',
      })
    ).toThrow('Unsupported Wework package target: win32-arm64')
  })

  test('uses target-specific executable names when the host platform differs', () => {
    const targets = resolveDesktopPackageTargets(
      {
        WEWORK_RELEASE_ARCH: 'x64',
        WEWORK_RELEASE_PLATFORM: 'windows',
      },
      { platform: 'darwin', arch: 'arm64' }
    )

    expect(targetExecutableName(targets.cargoTarget, 'wegent-executor')).toBe('wegent-executor.exe')
    expect(targetExecutableName(targets.dwsTarget, 'dws')).toBe('dws.exe')
    expect(targetExecutableName('aarch64-apple-darwin', 'dws')).toBe('dws')
  })
})
