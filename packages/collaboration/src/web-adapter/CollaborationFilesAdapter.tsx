// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  CollaborationFilesView,
  type CollaborationFilePreviewProps,
} from "../files";
import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type { CollaborationProject } from "../types";
import {
  createCollaborationTranslator,
  type CollaborationLocale,
} from "../i18n";
import { createSharedWorkspaceFilesViewApi } from "./createSharedWorkspaceFilesViewApi";

function BrowserFilePreview({
  file,
  binaryFile,
  loading,
  error,
  onRetry,
}: CollaborationFilePreviewProps) {
  if (loading) return <p>Loading…</p>;
  if (error) {
    return (
      <div role="alert">
        <p>{error}</p>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (file)
    return <pre className="collaboration-web-file-preview">{file.content}</pre>;
  if (binaryFile) {
    return (
      <p>
        {binaryFile.name} · {binaryFile.size} B
      </p>
    );
  }
  return null;
}

async function saveBrowserDownload(
  blob: Blob,
  filename: string,
): Promise<void> {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function CollaborationFilesAdapter({
  api,
  project,
  locale,
}: {
  api: Pick<SharedWorkspaceApi, "files" | "attachments">;
  project: CollaborationProject;
  locale: CollaborationLocale;
}) {
  const filesApi = createSharedWorkspaceFilesViewApi(api);

  return (
    <CollaborationFilesView
      api={filesApi}
      project={project}
      PreviewComponent={BrowserFilePreview}
      saveDownload={saveBrowserDownload}
      t={createCollaborationTranslator(locale)}
    />
  );
}
