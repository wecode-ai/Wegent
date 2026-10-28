export function nodeInlineCommand(script) {
  // Keep script contents out of POSIX and PowerShell string interpolation.
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
}
