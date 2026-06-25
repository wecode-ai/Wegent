import { afterEach, describe, expect, test } from 'vitest'
import { isTauriRuntime } from './runtime-environment'

function setGlobalIsTauri(value: boolean) {
  Object.defineProperty(globalThis, 'isTauri', {
    configurable: true,
    value,
  })
}

function setTauriInternals() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
}

function clearTauriRuntime() {
  delete (globalThis as typeof globalThis & { isTauri?: boolean }).isTauri
  delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__
}

describe('isTauriRuntime', () => {
  afterEach(() => {
    clearTauriRuntime()
  })

  test('uses the Tauri v2 runtime marker', () => {
    setGlobalIsTauri(true)

    expect(isTauriRuntime()).toBe(true)
  })

  test('keeps supporting the legacy Tauri global', () => {
    setTauriInternals()

    expect(isTauriRuntime()).toBe(true)
  })

  test('returns false in a regular browser runtime', () => {
    expect(isTauriRuntime()).toBe(false)
  })
})
