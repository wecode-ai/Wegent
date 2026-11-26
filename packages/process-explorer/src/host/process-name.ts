/** macOS and Linux limit kernel-reported executable names to this length. */
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

  // Find the shortest prefix of the command line whose last path segment is
  // the executable. Paths with spaces resolve at their real boundary because
  // no earlier segment can match the kernel name.
  let boundary = trimmed.indexOf(' ')
  while (boundary !== -1) {
    const candidate = basename(trimmed.slice(0, boundary))
    if (isExecutableName(candidate, kernelName)) return candidate
    boundary = trimmed.indexOf(' ', boundary + 1)
  }

  // The command line does not start with the executable path (PATH lookup,
  // shell scripts). Its first word is argv[0] when it agrees with the kernel.
  const invoked = basename(firstWord(trimmed))
  if (isExecutableName(invoked, kernelName)) return invoked
  // argv[0] was rewritten by the caller; the kernel name is all we know.
  return kernelName
}

function isExecutableName(name: string, kernelName: string): boolean {
  // Linux keeps 15 characters, macOS 16; treat a full-length name as truncated.
  const truncated = kernelName.length >= MAX_COMM_LENGTH - 1
  return name === kernelName || (truncated && name.startsWith(kernelName))
}

function firstWord(value: string): string {
  return value.split(/\s+/, 1)[0] ?? ''
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
