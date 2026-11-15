/// <reference types="node" />
import { createRequire } from 'node:module'
import { vi } from 'vitest'

const require = createRequire(import.meta.url)
const requireFromReactNative = createRequire(require.resolve('react-native/package.json'))

// Resolve exactly the dependency installed by React Native's Libraries/Core/setUpXHR.js.
const native = requireFromReactNative('abort-controller/dist/abort-controller')

export function installReactNativeAbortGlobals(): void {
  vi.stubGlobal('AbortController', native.AbortController)
  vi.stubGlobal('AbortSignal', native.AbortSignal)
}
