// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type {
  SharedWorkspaceAttachmentsApi,
  SharedWorkspaceFilesApi,
} from "../ports/SharedWorkspaceApi";
import { createSharedWorkspaceFilesViewApi } from "./createSharedWorkspaceFilesViewApi";

function createSource() {
  const files = {
    list: vi.fn(async () => []),
    listDeliveryFiles: vi.fn(async () => [
      {
        assetId: "asset-1",
        deliveryId: "delivery-1",
        issueId: "ISSUE-1",
        issueTitle: "Prepare report",
        relativePath: "reports/result.md",
        displayName: "result.md",
        contentType: "text/markdown",
        sizeBytes: 128,
        deliveredAt: "2026-09-10T00:00:00Z",
        issuePath: [{ id: "ISSUE-1", title: "Prepare report" }],
      },
    ]),
    createFolder: vi.fn(),
    upload: vi.fn(),
    access: vi.fn(async () => ({ url: "file-url", expiresInSeconds: 60 })),
    read: vi.fn(async () => new Blob(["file"])),
    move: vi.fn(),
    remove: vi.fn(),
    accessDeliveryFile: vi.fn(async () => ({
      url: "delivery-url",
      expiresInSeconds: 60,
    })),
    readDeliveryFile: vi.fn(async () => new Blob(["delivery"])),
  } as unknown as SharedWorkspaceFilesApi;
  const attachments = {
    listProjectTaskAttachments: vi.fn(async () => [
      {
        id: "attachment-1",
        loop_item_id: "ISSUE-1",
        loop_item_title: "Prepare report",
        display_name: "context.png",
        content_type: "image/png",
        size_bytes: 256,
        created_by_user_id: 1,
        created_at: "2026-09-10T00:00:00Z",
        markdown_url: "wegent://attachments/attachment-1",
      },
    ]),
    access: vi.fn(async () => ({
      url: "attachment-url",
      expiresInSeconds: 60,
    })),
    read: vi.fn(async () => new Blob(["attachment"])),
  } as unknown as SharedWorkspaceAttachmentsApi;

  return { attachments, files };
}

describe("createSharedWorkspaceFilesViewApi", () => {
  it("maps shared workspace files, deliveries, and task attachments once", async () => {
    const source = createSource();
    const api = createSharedWorkspaceFilesViewApi(source);

    await expect(api.listFiles(13)).resolves.toEqual([]);
    await expect(api.listDeliveryFiles(13)).resolves.toEqual([
      {
        asset_id: "asset-1",
        delivery_id: "delivery-1",
        loop_item_id: "ISSUE-1",
        loop_item_title: "Prepare report",
        relative_path: "reports/result.md",
        display_name: "result.md",
        content_type: "text/markdown",
        size_bytes: 128,
        delivered_at: "2026-09-10T00:00:00Z",
        loop_item_path: [{ id: "ISSUE-1", title: "Prepare report" }],
      },
    ]);
    await expect(api.listTaskAttachments?.(13)).resolves.toEqual([
      {
        id: "attachment-1",
        loop_item_id: "ISSUE-1",
        loop_item_title: "Prepare report",
        display_name: "context.png",
        content_type: "image/png",
        size_bytes: 256,
        created_at: "2026-09-10T00:00:00Z",
      },
    ]);
    expect(source.files.list).toHaveBeenCalledWith("13");
    expect(source.files.listDeliveryFiles).toHaveBeenCalledWith("13");
    expect(source.attachments.listProjectTaskAttachments).toHaveBeenCalledWith(
      "13",
    );
  });

  it("uses host access reading only for downloads", async () => {
    const source = createSource();
    const downloaded = new Blob(["downloaded"]);
    const readAccess = vi.fn(async () => downloaded);
    const saveTaskAttachment = vi.fn(async () => undefined);
    const api = createSharedWorkspaceFilesViewApi(source, {
      readAccess,
      saveTaskAttachment,
    });

    await expect(api.previewFile("file-1")).resolves.toEqual(expect.any(Blob));
    await expect(api.downloadFile("file-1")).resolves.toBe(downloaded);
    await expect(api.downloadDeliveryFile("asset-1")).resolves.toBe(downloaded);
    await api.openTaskAttachment?.("attachment-1", "context.png");

    expect(readAccess).toHaveBeenNthCalledWith(1, {
      url: "file-url",
      expiresInSeconds: 60,
    });
    expect(readAccess).toHaveBeenNthCalledWith(2, {
      url: "delivery-url",
      expiresInSeconds: 60,
    });
    expect(readAccess).toHaveBeenNthCalledWith(3, {
      url: "attachment-url",
      expiresInSeconds: 60,
    });
    expect(saveTaskAttachment).toHaveBeenCalledWith(
      expect.any(Blob),
      "context.png",
    );
    expect(source.files.read).toHaveBeenCalledTimes(1);
  });

  it("omits task attachment capabilities when no attachment source is provided", () => {
    const source = createSource();
    const api = createSharedWorkspaceFilesViewApi({ files: source.files });

    expect(api.listTaskAttachments).toBeUndefined();
    expect(api.previewTaskAttachment).toBeUndefined();
    expect(api.openTaskAttachment).toBeUndefined();
  });
});
