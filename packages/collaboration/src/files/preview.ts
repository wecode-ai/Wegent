export type CollaborationFilePreviewKind = "text" | "binary" | "unknown";

import { mimeTypeForFileName } from "@wegent/chat-core/workspace-file-types";

function mediaType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

export function normalizeAttachmentBlob(
  blob: Blob,
  filename: string,
  contentType?: string | null,
): Blob {
  const responseType = mediaType(blob.type);
  const declaredType = mediaType(contentType ?? "");
  const type =
    responseType && responseType !== "application/octet-stream"
      ? responseType
      : declaredType && declaredType !== "application/octet-stream"
        ? declaredType
        : mimeTypeForFileName(filename);
  return type && type !== blob.type ? blob.slice(0, blob.size, type) : blob;
}

export function attachmentPreviewKind(filename: string, contentType: string) {
  const normalizedType = mediaType(contentType);
  if (normalizedType.startsWith("image/")) return "image";
  if (
    /\.(?:md|markdown)$/i.test(filename) ||
    normalizedType === "text/markdown"
  )
    return "markdown";
  if (normalizedType === "application/pdf") return "pdf";
  return collaborationFilePreviewKind(filename, normalizedType);
}

const TEXT_FILE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "dart",
  "go",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "log",
  "md",
  "markdown",
  "mjs",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

const BINARY_FILE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "doc",
  "docx",
  "epub",
  "gif",
  "jpeg",
  "jpg",
  "mermaid",
  "mmd",
  "odp",
  "ods",
  "odt",
  "pdf",
  "plantuml",
  "png",
  "ppt",
  "pptx",
  "puml",
  "tif",
  "tiff",
  "webp",
  "xls",
  "xlsx",
  "xmind",
  "zip",
]);

const TEXT_FILE_NAMES = new Set([
  "dockerfile",
  "license",
  "makefile",
  "readme",
]);

function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

export function collaborationFilePreviewKind(
  path: string,
  contentType = "",
): CollaborationFilePreviewKind {
  const name = fileName(path);
  if (TEXT_FILE_NAMES.has(name) || name.startsWith("dockerfile."))
    return "text";

  const dotIndex = name.lastIndexOf(".");
  const extension = dotIndex >= 0 ? name.slice(dotIndex + 1) : "";
  if (TEXT_FILE_EXTENSIONS.has(extension)) return "text";
  if (BINARY_FILE_EXTENSIONS.has(extension)) return "binary";

  const normalizedContentType = contentType.toLowerCase();
  if (
    normalizedContentType.startsWith("text/") ||
    normalizedContentType.includes("json") ||
    normalizedContentType.includes("xml") ||
    normalizedContentType.includes("yaml") ||
    normalizedContentType.includes("javascript")
  ) {
    return "text";
  }
  if (
    normalizedContentType.startsWith("image/") ||
    normalizedContentType === "application/pdf" ||
    normalizedContentType === "application/zip" ||
    normalizedContentType.includes("officedocument") ||
    normalizedContentType.includes("opendocument") ||
    normalizedContentType === "application/msword" ||
    normalizedContentType === "application/vnd.ms-excel" ||
    normalizedContentType === "application/vnd.ms-powerpoint"
  ) {
    return "binary";
  }
  return "unknown";
}

export function isLikelyCollaborationTextContent(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return true;
  if (bytes.includes(0)) return false;

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }

  let controlCharacters = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0 && codePoint <= 8) ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
    ) {
      controlCharacters += 1;
    }
  }
  return controlCharacters / Math.max(text.length, 1) <= 0.01;
}
