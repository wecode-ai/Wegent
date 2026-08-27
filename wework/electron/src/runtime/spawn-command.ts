export interface ResolvedSpawnCommand {
  command: string
  args: string[]
}

export function resolveSpawnCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  commandInterpreter = process.env.ComSpec || 'cmd.exe'
): ResolvedSpawnCommand {
  if (
    platform !== 'win32' ||
    (!command.toLowerCase().endsWith('.cmd') && !command.toLowerCase().endsWith('.bat'))
  ) {
    return { command, args }
  }

  return {
    command: commandInterpreter,
    args: ['/c', command, ...args],
  }
}
