import { COMPOSER_SKILL_ICON_PATHS } from "./composerSkillIconPaths";

const documentOutline =
  "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z M14 2v6h6";
export const PENCIL_SKILL_ICON_PATHS = [
  "M16 4l4 4L9 19l-5 1 1-5Z M14 6l4 4",
  "M5 2v6 M2 5h6 M20 14v6 M17 17h6",
] as const;

export function fileReferenceIconPaths(path: string): readonly string[] {
  const name =
    path
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      ?.split(/[?#]/, 1)[0]
      .toLowerCase() ?? "";
  if (name === "skill.md") return COMPOSER_SKILL_ICON_PATHS;
  const extension = name.split(".").at(-1);
  if (extension && ["json", "jsonc"].includes(extension))
    return [documentOutline, "M10 11H9v3l-1 1 1 1v3h1 M14 11h1v3l1 1-1 1v3h-1"];
  if (
    extension &&
    ["sh", "bash", "zsh", "ps1", "bat", "cmd"].includes(extension)
  )
    return [documentOutline, "m8 12 3 3-3 3 M13 18h3"];
  if (extension && ["csv", "tsv", "xls", "xlsx", "xlsm"].includes(extension))
    return [documentOutline, "M8 11h8v8H8Z M8 15h8 M12 11v8"];
  if (
    extension &&
    [
      "js",
      "jsx",
      "ts",
      "tsx",
      "py",
      "rs",
      "go",
      "c",
      "cpp",
      "java",
      "html",
      "css",
      "php",
      "rb",
    ].includes(extension)
  )
    return [documentOutline, "m10 12-3 3 3 3 m4-6 3 3-3 3"];
  if (
    extension &&
    ["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(extension)
  )
    return [documentOutline, "m7 18 3-4 3 3 2-2 3 3 M8 10h.01"];
  return [documentOutline, "M8 13h8 M8 17h6"];
}
