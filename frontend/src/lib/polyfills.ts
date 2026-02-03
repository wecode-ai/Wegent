/**
 * Polyfills for iOS 16 Safari compatibility
 *
 * iOS 16 Safari lacks support for some ES2022+ features that modern
 * npm packages may use. This file provides polyfills for those features.
 */

// Type declarations for polyfills
declare global {
  interface ObjectConstructor {
    hasOwn?(obj: object, prop: PropertyKey): boolean
  }
}

if (typeof window !== 'undefined') {
  // Object.hasOwn polyfill (ES2022)
  // Used by many modern libraries for property checking
  if (!Object.hasOwn) {
    ;(Object as ObjectConstructor).hasOwn = function (obj: object, prop: PropertyKey): boolean {
      return Object.prototype.hasOwnProperty.call(obj, prop)
    }
  }

  // Array.prototype.at polyfill (ES2022)
  // Provides negative indexing support for arrays
  if (!Array.prototype.at) {
    Array.prototype.at = function <T>(this: T[], n: number): T | undefined {
      n = Math.trunc(n) || 0
      if (n < 0) n += this.length
      if (n < 0 || n >= this.length) return undefined
      return this[n]
    }
  }

  // String.prototype.at polyfill (ES2022)
  // Provides negative indexing support for strings
  if (!String.prototype.at) {
    String.prototype.at = function (n: number): string | undefined {
      n = Math.trunc(n) || 0
      if (n < 0) n += this.length
      if (n < 0 || n >= this.length) return undefined
      return this.charAt(n)
    }
  }

  // TypedArray.prototype.at polyfill (ES2022)
  // For consistency with Array.prototype.at
  const typedArrayTypes = [
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
  ]

  typedArrayTypes.forEach(TypedArrayConstructor => {
    if (!TypedArrayConstructor.prototype.at) {
      TypedArrayConstructor.prototype.at = function (n: number) {
        n = Math.trunc(n) || 0
        if (n < 0) n += this.length
        if (n < 0 || n >= this.length) return undefined
        return this[n]
      }
    }
  })
}

export {}
