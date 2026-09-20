export type ComposerReferenceKind =
  | "skill"
  | "app"
  | "plugin"
  | "file"
  | "folder"
  | "cloud"
  | "conversation";

const referenceSchemes: [string, ComposerReferenceKind][] = [
  ["app://", "app"],
  ["plugin://", "plugin"],
  ["file://", "file"],
  ["folder://", "folder"],
  ["cloud://", "cloud"],
  ["wework-conversation://", "conversation"],
];

export function classifyComposerReference(
  label: string,
  href: string,
): ComposerReferenceKind | null {
  if (!href) return null;
  const scheme = referenceSchemes.find(([prefix]) => href.startsWith(prefix));
  if (scheme) return scheme[1];
  if (!label.trim().startsWith("$")) return null;
  try {
    const url = new URL(href);
    if (
      !/\s/u.test(href.trim()) &&
      (url.protocol === "http:" || url.protocol === "https:")
    )
      return null;
  } catch {
    // Filesystem paths do not need to be URLs or absolute paths.
  }
  return "skill";
}

export interface ComposerReference {
  label: string;
  href: string;
  reference: string;
  start: number;
  end: number;
}

export function parseComposerReferences(value: string): ComposerReference[] {
  const references: ComposerReference[] = [];
  for (
    let start = value.indexOf("[");
    start >= 0;
    start = value.indexOf("[", start + 1)
  ) {
    let labelEnd = start + 1;
    while (labelEnd < value.length && !/[\r\n\]]/.test(value[labelEnd])) {
      if (
        value[labelEnd] === "\\" &&
        (value[labelEnd + 1] === "\\" ||
          (value[labelEnd + 1] === "]" && value[labelEnd + 2] !== "("))
      )
        labelEnd++;
      labelEnd++;
    }
    if (labelEnd === start + 1 || value.slice(labelEnd, labelEnd + 2) !== "](")
      continue;
    let end = labelEnd + 2;
    while (end < value.length && !/[\r\n)]/.test(value[end])) {
      if (value[end] === "\\" && end + 1 < value.length) {
        if (/[\r\n]/.test(value[end + 1])) break;
        end++;
      }
      end++;
    }
    if (end === labelEnd + 2 || value[end] !== ")") continue;
    references.push({
      label: unescapeMarkdownReference(value.slice(start + 1, labelEnd)),
      href: unescapeMarkdownReference(value.slice(labelEnd + 2, end)),
      reference: value.slice(start, end + 1),
      start,
      end: end + 1,
    });
    start = end;
  }
  return references;
}

export function unescapeMarkdownReference(value: string): string {
  return value.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

export function parseComposerReference(
  value: string,
): ComposerReference | null {
  const reference = parseComposerReferences(value)[0];
  return reference?.start === 0 && reference.end === value.length
    ? reference
    : null;
}

export function composerSkillName(label: string): {
  name: string;
  displayLabel?: string;
  icon?: "pencil-sparkle";
} {
  const value = label.trim().replace(/^\$/, "");
  const queryStart = value.indexOf("?");
  if (queryStart < 0) return { name: value };
  const parameters = new URLSearchParams(value.slice(queryStart + 1));
  const displayLabel = parameters.get("label")?.trim();
  return {
    name: value.slice(0, queryStart).trim(),
    displayLabel: displayLabel || undefined,
    ...(parameters.get("icon") === "pencil-sparkle"
      ? { icon: "pencil-sparkle" as const }
      : {}),
  };
}
