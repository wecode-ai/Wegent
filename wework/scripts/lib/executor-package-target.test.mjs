import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

import {
  executorPackageBinaryPath,
  resolveExecutorPackageTargetDirectory,
} from './executor-package-target.mjs'

describe('executor package target', () => {
  test('isolates package builds from an ambient shared Cargo target', () => {
    const executorRoot = resolve('/workspace/current-worktree/executor')

    expect(
      resolveExecutorPackageTargetDirectory(
        { CARGO_TARGET_DIR: '/cache/shared-across-worktrees' },
        executorRoot
      )
    ).toBe(join(executorRoot, 'target', 'wework-package'))
  })

  test('uses the explicit package target directory', () => {
    expect(
      resolveExecutorPackageTargetDirectory(
        { WEWORK_EXECUTOR_TARGET_DIR: '/ci/current-build/executor-target' },
        '/workspace/executor'
      )
    ).toBe(resolve('/ci/current-build/executor-target'))
  })

  test('resolves the target-specific executor output', () => {
    expect(
      executorPackageBinaryPath(
        '/ci/current-build/executor-target',
        'x86_64-pc-windows-msvc',
        'debug'
      )
    ).toBe(
      join(
        '/ci/current-build/executor-target',
        'x86_64-pc-windows-msvc',
        'debug',
        'wegent-executor.exe'
      )
    )
  })
})
