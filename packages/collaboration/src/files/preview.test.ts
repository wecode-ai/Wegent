import { describe, expect, it } from "vitest";
import {
  collaborationFilePreviewKind,
  isLikelyCollaborationTextContent,
  normalizeAttachmentBlob,
  attachmentPreviewKind,
} from "./preview";

describe("collaboration file preview classification", () => {
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
