/**
 * Kernel-reported executable names are truncated to this many bytes: 16 on
 * macOS, 15 plus a terminator on Linux.
 */
export const MAX_COMM_LENGTH = 16

/**
 * Derives the executable name from a command line and the kernel's reported
 * name (`ucomm` on macOS, `comm` on Linux). The command line is authoritative
 * when it starts with the executable path, because the kernel truncates names
 * longer than the limit.
 */
export function resolveProcessName(args: string, kernelName: string): string {
  const trimmed = args.trim()
  const zombie = /^\[(.*)\]$/.exec(trimmed)
  if (zombie) return zombie[1]
  if (!kernelName) return firstWord(trimmed)
  if (!trimmed) return kernelName
  const truncated = isTruncated(kernelName)

  // Find the shortest prefix of the command line whose last path segment is
  // the executable. Paths with spaces resolve at their real boundary because
  // no earlier segment can match the kernel name. The last slash is carried
  // forward so each candidate costs only its own name.
  let lastSlash = -1
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]
    if (character === '/') lastSlash = index
    else if (/\s/.test(character)) {
      const candidate = trimmed.slice(lastSlash + 1, index)
      if (isExecutableName(candidate, kernelName, truncated)) return candidate
    }
  }

  // The command line is the executable path alone.
  const whole = trimmed.slice(lastSlash + 1)
  if (isExecutableName(whole, kernelName, truncated)) return whole

  // The command line does not start with the executable path (PATH lookup,
  // shell scripts). Its first word is argv[0] when it agrees with the kernel.
  const invoked = basename(firstWord(trimmed))
  if (isExecutableName(invoked, kernelName, truncated)) return invoked
  // argv[0] was rewritten by the caller; the kernel name is all we know.
  return kernelName
}

function isExecutableName(name: string, kernelName: string, truncated: boolean): boolean {
  return name === kernelName || (truncated && name.startsWith(kernelName))
}

function isTruncated(kernelName: string): boolean {
  return new TextEncoder().encode(kernelName).length >= MAX_COMM_LENGTH - 1
}

function firstWord(value: string): string {
  return value.split(/\s+/, 1)[0] ?? ''
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
