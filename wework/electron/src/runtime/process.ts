// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type ExecFileOptions,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Spawn a subprocess with Windows console windows hidden by default. Every
 * background subprocess should go through this helper so Windows builds
 * cannot reintroduce console flashes. Use {@link spawnVisible} when showing a
 * terminal window is intentional.
 */
export function spawnProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
): ChildProcessWithoutNullStreams
export function spawnProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions
): ChildProcess
export function spawnProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {}
) {
  return spawn(command, args, { ...options, windowsHide: true })
}

/** Spawn a subprocess and keep its terminal window visible on Windows. */
export function spawnVisible(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {}
) {
  return spawn(command, args, options)
}

const execFileAsyncImpl = promisify(execFile)

/** `execFile` promisified with Windows console windows hidden by default. */
export function execFileAsync(
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsyncImpl(file, args, { ...options, windowsHide: true }) as Promise<{
    stdout: string
    stderr: string
  }>
}
