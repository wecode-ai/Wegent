export function textMetrics(value: string | undefined | null) {
  const text = value ?? "";
  return {
    length: text.length,
    trimmedLength: text.trim().length,
    lineCount: text.length > 0 ? text.split("\n").length : 0,
  };
}
