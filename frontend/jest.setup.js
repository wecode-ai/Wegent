// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { TextEncoder } from 'node:util'
import '../packages/collaboration/src/test/setup'

// JSDOM omits this browser API; use the native implementation for byte-size validation.
global.TextEncoder = TextEncoder

// Preserve browser cancellation semantics in the older JSDOM AbortSignal.
if (!AbortSignal.prototype.throwIfAborted) {
  AbortSignal.prototype.throwIfAborted = function () {
    if (this.aborted) throw this.reason
  }
}

if (typeof Element !== 'undefined' && !Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
}

if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {}
}

if (typeof Element !== 'undefined' && !Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {}
}

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {}
}

// JSDOM does not record paint timings used by UI SDK positioning.
if (typeof performance !== 'undefined' && !performance.getEntriesByType) {
  performance.getEntriesByType = () => []
}

// Layout-only API used by shared activity content expansion.
if (!global.ResizeObserver) {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
