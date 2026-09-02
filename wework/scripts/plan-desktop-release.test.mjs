import { describe, expect, test } from 'vitest'

import {
  classifyDesktopChanges,
  planDesktopRelease,
  resolveCurrentRelease,
} from './plan-desktop-release.mjs'

const tags = ['wework-v0.2.7', 'wework-v0.2.8-beta.1', 'wework-v0.2.8']

describe('Wework desktop release planning', () => {
  test('resolves the installed baseline for each channel', () => {
    expect(resolveCurrentRelease(tags, 'stable')).toEqual({
      tag: 'wework-v0.2.8',
      version: '0.2.8',
    })
    expect(resolveCurrentRelease(tags, 'beta')).toEqual({
      tag: 'wework-v0.2.8',
      version: '0.2.8',
    })
    expect(resolveCurrentRelease(['wework-v0.2.8-beta.2', 'wework-v0.2.7'], 'beta')).toEqual({
      tag: 'wework-v0.2.8-beta.2',
      version: '0.2.8-beta.2',
    })
  })

  test('classifies renderer, DSH, executor, and managed runtime changes as components', () => {
    expect(
      classifyDesktopChanges([
        'wework/src/App.tsx',
        'wework/dsh/app-wework/client.js',
        'executor/src/bin/wegent-executor.rs',
        'packages/chat-core/src/socket.ts',
        'wework/resources/bundled-plugins/wework-personal/plugin.json',
        'wework/resources/binaries/dws-aarch64-apple-darwin',
        'wework/resources/bundled-harness-runtime/runtimes.json',
        'pnpm-lock.yaml',
      ])
    ).toBe('component')
  })

  test('requires a full release for Electron host and unmanaged resource changes', () => {
    expect(classifyDesktopChanges(['wework/electron/src/main.ts'])).toBe('full')
    expect(classifyDesktopChanges(['wework/resources/icons/icon.icns'])).toBe('full')
    expect(classifyDesktopChanges(['.github/workflows/wework-app.yml'])).toBe('full')
  })

  test('ignores changes that do not affect the desktop release', () => {
    expect(
      classifyDesktopChanges([
        'backend/app/main.py',
        'docs/zh/index.md',
        'wework/e2e/desktop/task-flow.e2e.mjs',
        'wework/src/App.test.tsx',
        'wework/README.md',
      ])
    ).toBe('none')
  })

  test('keeps the installed app version for a component-only publication', () => {
    expect(
      planDesktopRelease({
        tags,
        changedPaths: ['wework/src/App.tsx'],
        channel: 'stable',
        candidateVersion: '0.2.9',
        candidateTag: 'wework-v0.2.9',
        candidatePrerelease: false,
        publishRelease: true,
        sourceSha: 'a'.repeat(40),
      })
    ).toEqual({
      kind: 'component',
      version: '0.2.8',
      releaseTag: `wework-v0.2.8-runtime.${'a'.repeat(12)}`,
      prerelease: false,
      baseTag: 'wework-v0.2.8',
    })
  })

  test('uses the previous published source as the component release notes baseline', () => {
    expect(
      planDesktopRelease({
        tags,
        changedPaths: ['executor/src/main.rs'],
        channel: 'stable',
        candidateVersion: '0.2.9',
        candidateTag: 'wework-v0.2.9',
        candidatePrerelease: false,
        publishRelease: true,
        sourceSha: 'b'.repeat(40),
        currentRelease: {
          tag: 'wework-v0.2.8',
          version: '0.2.8',
          sourceRef: 'a'.repeat(40),
        },
      })
    ).toMatchObject({
      releaseTag: `wework-v0.2.8-runtime.${'b'.repeat(12)}`,
      baseTag: 'a'.repeat(40),
    })
  })

  test('uses the candidate version when the host changed or no baseline exists', () => {
    expect(
      planDesktopRelease({
        tags,
        changedPaths: ['wework/electron/src/main.ts'],
        channel: 'stable',
        candidateVersion: '0.2.9',
        candidateTag: 'wework-v0.2.9',
        candidatePrerelease: false,
        publishRelease: true,
      })
    ).toMatchObject({
      kind: 'full',
      version: '0.2.9',
      releaseTag: 'wework-v0.2.9',
    })
    expect(
      planDesktopRelease({
        tags: [],
        changedPaths: [],
        channel: 'stable',
        candidateVersion: '0.0.1',
        candidateTag: 'wework-v0.0.1',
        candidatePrerelease: false,
        publishRelease: true,
      })
    ).toMatchObject({
      kind: 'full',
      version: '0.0.1',
    })
  })

  test('keeps dry-run builds on the complete package path', () => {
    expect(
      planDesktopRelease({
        tags,
        changedPaths: ['wework/src/App.tsx'],
        channel: 'stable',
        candidateVersion: '0.2.9',
        candidateTag: 'wework-v0.2.9',
        candidatePrerelease: false,
        publishRelease: false,
      })
    ).toMatchObject({
      kind: 'full',
      version: '0.2.9',
    })
  })

  test('keeps an explicit tag rebuild on the complete package path', () => {
    expect(
      planDesktopRelease({
        tags,
        changedPaths: [],
        channel: 'stable',
        candidateVersion: '0.2.8',
        candidateTag: 'wework-v0.2.8',
        candidatePrerelease: false,
        publishRelease: true,
        forceFull: true,
      })
    ).toMatchObject({
      kind: 'full',
      version: '0.2.8',
    })
  })
})
