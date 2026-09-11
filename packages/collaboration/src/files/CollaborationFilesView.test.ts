import { describe, expect, it, vi } from "vitest";

import { createCollaborationTranslator } from "../i18n";
import { collaborationFileBrowserEntries } from "./browser";
import { loadCollaborationFiles } from "./load";
import type {
  CollaborationDeliveryFile,
  CollaborationFilesApi,
  CollaborationProjectFile,
  CollaborationTaskAttachment,
} from "./types";

const sharedFile: CollaborationProjectFile = {
  id: "file-1",
  cloud_project_id: "project-1",
  path: "notes.txt",
  name: "notes.txt",
  kind: "file",
  content_type: "text/plain",
  size_bytes: 5,
  description: "",
  version: 1,
  created_at: "2026-09-11T00:00:00Z",
  updated_at: "2026-09-11T00:00:00Z",
};

const deliveryFile: CollaborationDeliveryFile = {
  asset_id: "asset-1",
  delivery_id: "delivery-1",
  loop_item_id: "TA-1",
  loop_item_title: "整理附件",
  relative_path: "reports/result.pdf",
  display_name: "result.pdf",
  content_type: "application/pdf",
  size_bytes: 256,
  delivered_at: "2026-09-11T00:00:00Z",
  loop_item_path: [{ id: "TA-1", title: "整理附件" }],
};

const taskAttachment: CollaborationTaskAttachment = {
  id: "attachment-1",
  loop_item_id: "TA-1",
  loop_item_title: "整理附件",
  display_name: "context.png",
  content_type: "image/png",
  size_bytes: 128,
  created_at: "2026-09-11T00:00:00Z",
};

function createApi(
  listTaskAttachments: () => Promise<CollaborationTaskAttachment[]>,
) {
  return {
    listFiles: vi.fn(async () => [sharedFile]),
    listDeliveryFiles: vi.fn(async () => [deliveryFile]),
    listTaskAttachments: vi.fn(listTaskAttachments),
  } as unknown as CollaborationFilesApi;
}

function createState() {
  return {
    files: [] as CollaborationProjectFile[],
    deliveryFiles: [] as CollaborationDeliveryFile[],
    taskAttachments: [] as CollaborationTaskAttachment[],
  };
}

describe("CollaborationFilesView loading", () => {
  it("keeps shared and delivery files when optional task attachments fail", async () => {
    const api = createApi(async () => {
      throw new Error("404 task attachments unavailable");
    });
    const state = createState();
    const onCoreError = vi.fn();

    await loadCollaborationFiles(api, "project-1", {
      onFiles: (files) => {
        state.files = files;
      },
      onDeliveryFiles: (files) => {
        state.deliveryFiles = files;
      },
      onTaskAttachments: (attachments) => {
        state.taskAttachments = attachments;
      },
      onCoreError,
    });

    expect(state.files).toEqual([sharedFile]);
    expect(state.deliveryFiles).toEqual([deliveryFile]);
    expect(state.taskAttachments).toEqual([]);
    expect(onCoreError).not.toHaveBeenCalled();
    expect(
      collaborationFileBrowserEntries(
        { scope: "deliveries", itemIds: [], assetPath: [] },
        state.files,
        state.deliveryFiles,
        createCollaborationTranslator("zh-CN"),
      ),
    ).toEqual([
      expect.objectContaining({
        key: "delivery-item:TA-1",
        name: "整理附件",
      }),
    ]);
  });

  it("keeps task attachments when the optional endpoint succeeds", async () => {
    const api = createApi(async () => [taskAttachment]);
    const state = createState();

    await loadCollaborationFiles(api, "project-1", {
      onFiles: (files) => {
        state.files = files;
      },
      onDeliveryFiles: (files) => {
        state.deliveryFiles = files;
      },
      onTaskAttachments: (attachments) => {
        state.taskAttachments = attachments;
      },
      onCoreError: vi.fn(),
    });

    expect(state.taskAttachments).toEqual([taskAttachment]);
    expect(api.listTaskAttachments).toHaveBeenCalledWith("project-1");
  });
});
