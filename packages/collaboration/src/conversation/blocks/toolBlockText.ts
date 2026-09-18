export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + "...";
}
