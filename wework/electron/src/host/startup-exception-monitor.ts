type StartupExceptionDetails = {
  errorKind: 'SyntaxError' | 'ReferenceError' | 'TypeError' | 'Error'
  origin: 'uncaughtException' | 'unhandledRejection' | 'unknown'
}

export function installStartupExceptionMonitor(
  report: (details: StartupExceptionDetails) => void
): () => void {
  const monitor = (error: Error, origin: NodeJS.UncaughtExceptionOrigin): void => {
    const errorKind =
      error instanceof SyntaxError
        ? 'SyntaxError'
        : error instanceof ReferenceError
          ? 'ReferenceError'
          : error instanceof TypeError
            ? 'TypeError'
            : 'Error'
    report({
      errorKind,
      origin:
        origin === 'uncaughtException' || origin === 'unhandledRejection' ? origin : 'unknown',
    })
  }
  process.on('uncaughtExceptionMonitor', monitor)
  return () => process.off('uncaughtExceptionMonitor', monitor)
}
