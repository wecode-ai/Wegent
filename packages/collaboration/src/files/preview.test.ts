import { describe, expect, it } from "vitest";
import {
  collaborationFilePreviewKind,
  isLikelyCollaborationTextContent,
  normalizeAttachmentBlob,
  attachmentPreviewKind,
} from "./preview";

describe("collaboration file preview classification", () => {
  it("normalizes response parameters and generic metadata without overriding an explicit media type", () => {
    const image = normalizeAttachmentBlob(
      new Blob(["png"], { type: "application/octet-stream; charset=binary" }),
      "resource",
      "IMAGE/PNG; charset=binary",
    );
    expect(image.type).toBe("image/png");
    const html = normalizeAttachmentBlob(
      new Blob(["html"], { type: "text/html; charset=utf-8" }),
      "image.png",
      "image/png",
    );
    expect(html.type).toBe("text/html");
    expect(html.size).toBe(4);
  });
  it.each([
    ["TEXT/MARKDOWN; charset=utf-8", "markdown"],
    ["application/pdf; charset=binary", "pdf"],
    [" Image/PNG ; charset=binary", "image"],
  ])(
    "classifies parameterized MIME %s without requiring a filename extension",
    (type, kind) => {
      expect(attachmentPreviewKind("resource", type)).toBe(kind);
    },
  );
  it.each([
    ["image.png", "image/png"],
    ["image.svg", "image/svg+xml"],
    ["image.avif", "image/avif"],
    ["image.webp", "image/webp"],
  ])(
    "uses the shared MIME registry for generic %s downloads",
    (filename, type) => {
      const blob = normalizeAttachmentBlob(
        new Blob(["bytes"], { type: "application/octet-stream" }),
        filename,
      );
      expect(blob.type).toBe(type);
      expect(blob.size).toBe(5);
      expect(attachmentPreviewKind(filename, blob.type)).toBe("image");
    },
  );

  it("preserves explicit response types instead of guessing from a filename", () => {
    const blob = new Blob(["<html>"], { type: "text/html" });
    expect(normalizeAttachmentBlob(blob, "image.png", "image/png")).toBe(blob);
    expect(attachmentPreviewKind("report.md", "application/octet-stream")).toBe(
      "markdown",
    );
    expect(attachmentPreviewKind("report", "text/markdown")).toBe("markdown");
    expect(attachmentPreviewKind("report.pdf", "text/html")).toBe("binary");
  });
  it("preserves text and binary extension handling", () => {
    expect(
      collaborationFilePreviewKind("src/main.zig", "application/octet-stream"),
    ).toBe("unknown");
    expect(
      collaborationFilePreviewKind("README", "application/octet-stream"),
    ).toBe("text");
    expect(collaborationFilePreviewKind("report.pdf", "text/plain")).toBe(
      "binary",
    );
    expect(collaborationFilePreviewKind("data.bin", "application/json")).toBe(
      "text",
    );
    expect(
      collaborationFilePreviewKind("settings.ini", "application/octet-stream"),
    ).toBe("text");
  });

  it("detects unknown UTF-8 text without treating binary bytes as text", () => {
    expect(
      isLikelyCollaborationTextContent(
        new TextEncoder().encode("const answer = 42"),
      ),
    ).toBe(true);
    expect(isLikelyCollaborationTextContent(new Uint8Array([0, 1, 2, 3]))).toBe(
      false,
    );
    expect(isLikelyCollaborationTextContent(new Uint8Array([0xff, 0xfe]))).toBe(
      false,
    );
  });
});
