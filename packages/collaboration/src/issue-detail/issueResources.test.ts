import { describe, expect, it, vi } from "vitest";
import { createIssueResources } from "./issueResources";
import type { SharedWorkspaceAttachmentsApi } from "../ports/SharedWorkspaceApi";

function fixture(
  rows = [
    {
      id: "file-uuid",
      display_name: "report.md",
      content_type: "text/markdown",
    },
  ],
) {
  const list = vi.fn().mockResolvedValue(rows);
  const read = vi.fn().mockResolvedValue(new Blob(["content"]));
  const resources = createIssueResources(
    { list, read } as unknown as SharedWorkspaceAttachmentsApi,
    "issue-6",
  );
  return { resources, list, read };
}

describe("Issue resource ownership and resolution", () => {
  it.each([
    ["wegent://attachments/file-uuid", "Alias"],
    ["/api/v1/loop-item-attachments/file-uuid/content", "Alias"],
    [
      "https://example.test/api/v1/loop-item-attachments/file-uuid/content",
      "Alias",
    ],
    ["/home/ubuntu/outputs/report.md", "Report"],
    ["./outputs/report.md", "Report"],
    ["file:///home/ubuntu/report.md", "Report"],
    ["C:\\outputs\\report.md", "Report"],
    ["/home/ubuntu/generated.md", "report.md"],
    ["/home/ubuntu/report.md:20", "Report"],
  ])("resolves %s with the same Issue registry", async (href, label) => {
    const { resources, list } = fixture();
    expect((await resources.resolve(href, label)).id).toBe("file-uuid");
    expect(list).toHaveBeenCalledExactlyOnceWith("issue-6");
  });

  it("preserves large attachment IDs without numeric conversion", async () => {
    const id = "9336494559207636217";
    const { resources } = fixture([
      { id, display_name: "report.md", content_type: "text/plain" },
    ]);
    expect(
      (await resources.resolve(`/api/attachments/${id}/download`)).id,
    ).toBe(id);
  });

  it.each([
    "https://example.com/report.md",
    "javascript:alert(1)",
    "folder:///report.md",
  ])("does not reinterpret %s as an attachment", async (href) => {
    const { resources, list, read } = fixture();
    await expect(resources.read(href, "report.md")).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects ambiguous names and IDs outside the current Issue", async () => {
    const { resources, read } = fixture([
      { id: "one", display_name: "report.md", content_type: "text/plain" },
      { id: "two", display_name: "report.md", content_type: "text/plain" },
    ]);
    await expect(resources.read("/remote/report.md")).rejects.toThrow(
      "ambiguous",
    );
    await expect(
      resources.read("wegent://attachments/outside-issue", "report.md"),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect((await resources.resolve("wegent://attachments/two")).id).toBe(
      "two",
    );
  });

  it("rejects conflicts between the link label and path basename", async () => {
    const { resources } = fixture([
      { id: "one", display_name: "report.md", content_type: "text/plain" },
      { id: "two", display_name: "other.md", content_type: "text/plain" },
    ]);
    await expect(
      resources.resolve("/remote/other.md", "report.md"),
    ).rejects.toThrow("ambiguous");
  });

  it("shares an in-flight index and refreshes after failure and later actions", async () => {
    const { resources, list } = fixture();
    await Promise.all([
      resources.resolve("/a/report.md"),
      resources.resolve("/b/report.md"),
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    list.mockRejectedValueOnce(new Error("offline"));
    await expect(resources.resolve("/a/report.md")).rejects.toThrow("offline");
    expect((await resources.resolve("/a/report.md")).id).toBe("file-uuid");
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("normalizes downloaded MIME using the resolved attachment metadata", async () => {
    const { resources, read } = fixture([
      { id: "image", display_name: "chart.png", content_type: "image/png" },
    ]);
    read.mockResolvedValue(
      new Blob(["png"], { type: "application/octet-stream" }),
    );
    const { blob, attachment } = await resources.read("/remote/chart.png");
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(3);
    expect(attachment.id).toBe("image");
    expect(read).toHaveBeenCalledExactlyOnceWith("image");
  });
});
