const sourcePaths = new WeakMap<File, string>()

declare global {
  interface Window {
    weworkElectronFiles?: {
      getPathForFile: (file: File) => string
    }
  }
}

export function rememberNativeFilePath(file: File, path: string): void {
  sourcePaths.set(file, path)
}

export function getNativeFilePath(file: File): string | null {
  const rememberedPath = sourcePaths.get(file)
  if (rememberedPath) return rememberedPath
  if (typeof window === 'undefined') return null
  return window.weworkElectronFiles?.getPathForFile(file) || null
}
