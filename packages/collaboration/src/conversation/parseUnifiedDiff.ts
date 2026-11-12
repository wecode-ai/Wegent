export interface DiffFileSection {
  oldPath?: string;
  path: string;
  lines: string[];
}

const QUOTED_DIFF_HEADER_PATTERN =
  /^diff --git ("a\/(?:\\.|[^"\\])*") ("b\/(?:\\.|[^"\\])*")$/;
const SAME_PATH_DIFF_HEADER_PATTERN = /^diff --git a\/(.+) b\/\1$/;

const GIT_PATH_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  '"': '"',
  "\\": "\\",
};

function decodeGitPath(path: string): string {
  if (!path.startsWith('"')) return path;
  return path
    .slice(1, -1)
    .replace(
      /(?:\\[0-7]{1,3})+|\\([abfnrtv"\\])/g,
      (escaped: string, control: string | undefined) => {
        if (control) return GIT_PATH_ESCAPES[control];
        // Git quotes non-ASCII filenames as octal UTF-8 bytes, not code points.
        const bytes = escaped
          .match(/[0-7]{1,3}/g)!
          .map((octal) => parseInt(octal, 8));
        return new TextDecoder().decode(new Uint8Array(bytes));
      },
    );
}

function parseFileSection(lines: string[]): DiffFileSection | null {
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let hasPathMetadata = false;

  for (const line of lines.slice(1)) {
    // Hunk contents may themselves look like file metadata.
    if (line.startsWith("@@") || line === "GIT binary patch") break;
    const fileMarker = line.match(/^(---|\+\+\+) (.*)$/);
    if (fileMarker) {
      const value = decodeGitPath(fileMarker[2].split("\t", 1)[0]);
      const path = value === "/dev/null" ? undefined : value.slice(2);
      if (fileMarker[1] === "---") oldPath = path;
      else newPath = path;
      hasPathMetadata = true;
    }
    const moveMarker = line.match(/^(?:rename|copy) (from|to) (.*)$/);
    if (moveMarker) {
      const path = decodeGitPath(moveMarker[2]);
      if (moveMarker[1] === "from") oldPath = path;
      else newPath = path;
      hasPathMetadata = true;
    }
  }

  if (!hasPathMetadata) {
    // Mode-only, empty and binary changes may have no path metadata. Only
    // accept unambiguous quoted tokens or an exactly repeated unquoted path.
    const quoted = lines[0].match(QUOTED_DIFF_HEADER_PATTERN);
    const samePath = lines[0].match(SAME_PATH_DIFF_HEADER_PATTERN)?.[1];
    oldPath = quoted ? decodeGitPath(quoted[1]).slice(2) : samePath;
    newPath = quoted ? decodeGitPath(quoted[2]).slice(2) : samePath;
    if (lines.some((line) => line.startsWith("new file mode ")))
      oldPath = undefined;
    if (lines.some((line) => line.startsWith("deleted file mode ")))
      newPath = undefined;
  }

  const path = newPath ?? oldPath;
  return path ? { oldPath, path, lines } : null;
}

export function parseUnifiedDiff(diff: string): DiffFileSection[] {
  const sections: DiffFileSection[] = [];
  const sectionsByPath = new Map<string, DiffFileSection>();
  let lines: string[] = [];
  const flush = () => {
    if (lines.length === 0) return;
    const section = parseFileSection(lines);
    if (!section) return;
    const existing = sectionsByPath.get(section.path);
    if (existing) existing.lines.push(...section.lines);
    else {
      sectionsByPath.set(section.path, section);
      sections.push(section);
    }
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      lines = [line];
    } else if (lines.length > 0) lines.push(line);
  }
  flush();
  return sections;
}
