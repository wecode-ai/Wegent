// Reject aliases that Windows resolves differently from ZIP and POSIX paths.
export function assertReleasePath(path) {
  if (
    !path ||
    path.includes('\\') ||
    path
      .split('/')
      .some(
        part =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[<>:"|?*]/.test(part) ||
          [...part].some(character => character.charCodeAt(0) < 32) ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  )
    throw new Error(`Unsafe release path: ${path}`)
}
