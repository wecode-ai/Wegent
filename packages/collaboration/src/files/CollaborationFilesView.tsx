import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  collaborationFileBrowserBreadcrumbs,
  collaborationFileBrowserEntries,
  type CollaborationFileBrowserLocation,
} from "./browser";
import {
  ChevronRightIcon,
  DownloadIcon,
  EyeIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  PencilIcon,
  TrashIcon,
  UploadIcon,
  XIcon,
} from "./icons";
import {
  collaborationFilePreviewKind,
  isLikelyCollaborationTextContent,
} from "./preview";
import type {
  CollaborationBinaryPreviewFile,
  CollaborationDeliveryFile,
  CollaborationFilesTranslate,
  CollaborationFilesViewProps,
  CollaborationProjectFile,
  CollaborationTaskAttachment,
  CollaborationTextPreviewFile,
} from "./types";

interface FilePreviewTarget {
  key: string;
  title: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number;
  load: () => Promise<Blob>;
}

const fallbackTranslate: CollaborationFilesTranslate = (
  _key,
  fallback,
  options,
) => {
  let value = fallback ?? _key;
  for (const [name, replacement] of Object.entries(options ?? {})) {
    value = value.split(`{{${name}}}`).join(String(replacement));
  }
  return value;
};

function downloadName(path: string): string {
  return path.split(/[\\/]/).pop() || "download";
}

export function formatCollaborationFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CollaborationFilesView({
  api,
  project,
  PreviewComponent,
  saveDownload,
  telemetry,
  t = fallbackTranslate,
  renderTooltip,
}: CollaborationFilesViewProps) {
  const [files, setFiles] = useState<CollaborationProjectFile[]>([]);
  const [deliveryFiles, setDeliveryFiles] = useState<
    CollaborationDeliveryFile[]
  >([]);
  const [taskAttachments, setTaskAttachments] = useState<
    CollaborationTaskAttachment[]
  >([]);
  const [folderName, setFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [editingFileId, setEditingFileId] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState("");
  const [previewTarget, setPreviewTarget] = useState<FilePreviewTarget | null>(
    null,
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewText, setPreviewText] =
    useState<CollaborationTextPreviewFile | null>(null);
  const [previewBinary, setPreviewBinary] =
    useState<CollaborationBinaryPreviewFile | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(
    null,
  );
  const projectLocationKey = String(project.id);
  const [locationState, setLocationState] = useState<{
    projectKey: string;
    location: CollaborationFileBrowserLocation;
  }>({ projectKey: projectLocationKey, location: { scope: "root" } });
  const location = useMemo<CollaborationFileBrowserLocation>(
    () =>
      locationState.projectKey === projectLocationKey
        ? locationState.location
        : { scope: "root" },
    [locationState, projectLocationKey],
  );
  const navigateTo = useCallback(
    (nextLocation: CollaborationFileBrowserLocation) =>
      setLocationState({
        projectKey: projectLocationKey,
        location: nextLocation,
      }),
    [projectLocationKey],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const previewRequestSequence = useRef(0);
  const showsTaskAttachments = Boolean(api.listTaskAttachments);

  const refresh = useCallback(() => {
    const taskAttachmentsRequest = api.listTaskAttachments
      ? api.listTaskAttachments(project.id)
      : Promise.resolve([]);
    void Promise.all([
      api.listFiles(project.id),
      api.listDeliveryFiles(project.id),
      taskAttachmentsRequest,
    ])
      .then(([shared, delivered, attachments]) => {
        setFiles(shared);
        setDeliveryFiles(delivered);
        setTaskAttachments(attachments);
      })
      .catch((cause) =>
        setError(
          cause instanceof Error
            ? cause.message
            : t("todo.files_load_failed", "加载文件失败"),
        ),
      );
  }, [api, project.id, t]);

  useEffect(refresh, [refresh]);

  const entries = useMemo(
    () => collaborationFileBrowserEntries(location, files, deliveryFiles, t),
    [deliveryFiles, files, location, t],
  );
  const breadcrumbs = useMemo(
    () => collaborationFileBrowserBreadcrumbs(location, deliveryFiles, t),
    [deliveryFiles, location, t],
  );
  const sharedPath = location.scope === "shared" ? location.path : [];
  const canManageSharedFiles =
    location.scope === "root" || location.scope === "shared";

  const withTooltip = (
    label: string,
    child: ReactNode,
    align: "start" | "center" | "end" = "center",
  ) =>
    renderTooltip ? (
      renderTooltip(label, child, align)
    ) : (
      <span title={label} className="inline-flex">
        {child}
      </span>
    );

  async function loadPreview(target: FilePreviewTarget) {
    const requestId = previewRequestSequence.current + 1;
    previewRequestSequence.current = requestId;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewText(null);
    setPreviewBinary(null);
    try {
      const blob = await target.load();
      if (previewRequestSequence.current !== requestId) return;
      const contentType =
        target.contentType || blob.type || "application/octet-stream";
      const previewKind = collaborationFilePreviewKind(
        target.filename,
        contentType,
      );
      const readAsText =
        previewKind === "text" ||
        (previewKind === "unknown" &&
          isLikelyCollaborationTextContent(
            new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer()),
          ));
      if (previewRequestSequence.current !== requestId) return;
      if (readAsText) {
        const content = await blob.text();
        if (previewRequestSequence.current !== requestId) return;
        setPreviewText({
          path: target.filename,
          name: target.filename,
          content,
          editable: false,
          revision: `${target.key}:${requestId}`,
          truncated: false,
          size: target.sizeBytes || blob.size,
        });
        return;
      }
      setPreviewBinary({
        path: target.filename,
        name: target.filename,
        size: target.sizeBytes || blob.size,
        file: new File([blob], target.filename, { type: contentType }),
      });
    } catch (cause) {
      if (previewRequestSequence.current !== requestId) return;
      setPreviewError(
        cause instanceof Error
          ? cause.message
          : t("todo.file_preview_failed", "预览失败"),
      );
    } finally {
      if (previewRequestSequence.current === requestId)
        setPreviewLoading(false);
    }
  }

  async function uploadFiles(selected: File[]) {
    if (selected.length === 0) return;
    setUploadingCount(selected.length);
    setError(null);
    try {
      const parentPath = sharedPath.join("/");
      await Promise.all(
        selected.map((file) =>
          api.uploadFile(
            project.id,
            file,
            parentPath ? `${parentPath}/${file.name}` : file.name,
          ),
        ),
      );
      refresh();
      telemetry?.completed("upload");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("todo.file_upload_failed", "上传失败，请重试"),
      );
      telemetry?.failed();
    } finally {
      setUploadingCount(0);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function createFolder() {
    const relativePath = folderName.trim().replace(/^\/+|\/+$/g, "");
    if (!relativePath || !canManageSharedFiles) return;
    const path = [...sharedPath, relativePath].filter(Boolean).join("/");
    setError(null);
    try {
      await api.createFolder(project.id, path);
      setFolderName("");
      setCreatingFolder(false);
      refresh();
      telemetry?.completed("create");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("todo.folder_create_failed", "创建文件夹失败"),
      );
      telemetry?.failed();
    }
  }

  async function downloadFile(
    id: string,
    filename: string,
    loadFile: () => Promise<Blob>,
  ): Promise<void> {
    setDownloadingFileId(id);
    setError(null);
    try {
      await saveDownload(await loadFile(), filename);
      telemetry?.completed("download");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("todo.file_download_failed", "下载文件失败"),
      );
      telemetry?.failed();
      throw cause;
    } finally {
      setDownloadingFileId(null);
    }
  }

  function showPreview(target: FilePreviewTarget) {
    setPreviewTarget(target);
    void loadPreview(target);
  }

  function previewCloudFile(entry: CollaborationProjectFile) {
    if (entry.kind !== "file") return;
    showPreview({
      key: `cloud-file:${entry.id}`,
      title: entry.path,
      filename: entry.name || downloadName(entry.path),
      contentType: entry.content_type,
      sizeBytes: entry.size_bytes,
      load: () => api.previewFile(entry.id),
    });
    telemetry?.completed("preview");
  }

  function previewDeliveryFile(entry: CollaborationDeliveryFile) {
    showPreview({
      key: `delivery-file:${entry.asset_id}`,
      title: entry.relative_path,
      filename: entry.display_name || downloadName(entry.relative_path),
      contentType: entry.content_type,
      sizeBytes: entry.size_bytes,
      load: () => api.previewDeliveryFile(entry.asset_id),
    });
    telemetry?.completed("preview");
  }

  function previewTaskAttachment(entry: CollaborationTaskAttachment) {
    if (!api.previewTaskAttachment) return;
    showPreview({
      key: `task-attachment:${entry.id}`,
      title: entry.display_name,
      filename: entry.display_name,
      contentType: entry.content_type,
      sizeBytes: entry.size_bytes,
      load: () => api.previewTaskAttachment!(entry.id),
    });
  }

  async function openTaskAttachment(entry: CollaborationTaskAttachment) {
    if (!api.openTaskAttachment) return;
    setError(null);
    try {
      await api.openTaskAttachment(entry.id, entry.display_name);
      telemetry?.completed("open");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("todo.open_task_attachment_failed", "打开任务附件失败"),
      );
      telemetry?.failed();
    }
  }

  async function deleteFile(entry: CollaborationProjectFile) {
    if (
      !window.confirm(
        t("todo.delete_file_confirm", "删除“{{path}}”？此操作无法撤销。", {
          path: entry.path,
        }),
      )
    )
      return;
    setError(null);
    try {
      await api.deleteFile(entry.id, entry.kind === "folder");
      setFiles((current) =>
        current.filter(
          (file) =>
            file.id !== entry.id && !file.path.startsWith(`${entry.path}/`),
        ),
      );
      telemetry?.completed("delete");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("todo.file_delete_failed", "删除失败"),
      );
      telemetry?.failed();
    }
  }

  async function moveFile(entry: CollaborationProjectFile) {
    const path = editingPath.trim();
    if (!path || path === entry.path) {
      setEditingFileId(null);
      return;
    }
    setError(null);
    try {
      await api.moveFile(entry.id, path, entry.version);
      setEditingFileId(null);
      refresh();
      telemetry?.completed("move");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("todo.file_move_failed", "重命名或移动失败"),
      );
      telemetry?.failed();
    }
  }

  return (
    <div data-testid="cloud-files-view" className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto px-8 py-7">
        <div className="mx-auto max-w-[1040px]">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-heading-md font-semibold">
                {t("todo.files_title", "文件")}
              </h2>
              <p className="mt-1 text-sm text-text-muted">
                {t(
                  "todo.files_description",
                  "浏览共享文件，以及按 Issue 和任务整理的交付快照。",
                )}
              </p>
            </div>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) =>
                void uploadFiles([...(event.target.files ?? [])])
              }
            />
            {canManageSharedFiles ? (
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  data-testid="cloud-folder-add"
                  onClick={() => setCreatingFolder(true)}
                  className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-hover"
                >
                  <FolderPlusIcon className="h-3.5 w-3.5" />
                  {t("todo.new_folder", "新建文件夹")}
                </button>
                <button
                  type="button"
                  data-testid="cloud-files-upload"
                  onClick={() => inputRef.current?.click()}
                  className="flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background"
                >
                  <UploadIcon className="h-3.5 w-3.5" />
                  {uploadingCount > 0
                    ? t("todo.uploading_file_count", "正在上传 {{count}} 项…", {
                        count: uploadingCount,
                      })
                    : t("todo.upload_files", "上传文件")}
                </button>
              </div>
            ) : null}
          </div>

          {creatingFolder && canManageSharedFiles ? (
            <div className="mt-4 flex items-center gap-2">
              <input
                autoFocus
                data-testid="cloud-folder-name"
                value={folderName}
                onChange={(event) => setFolderName(event.target.value)}
                onKeyDown={(event) =>
                  event.key === "Enter" && void createFolder()
                }
                placeholder={t("todo.folder_name_placeholder", "文件夹名称")}
                className="h-8 min-w-0 flex-1 rounded-md border border-border px-3 text-sm outline-none focus:border-focus"
              />
              <button
                type="button"
                data-testid="cloud-folder-create-confirm"
                onClick={() => void createFolder()}
                className="h-8 rounded-md bg-text-primary px-3 text-sm text-background"
              >
                {t("common.create", "创建")}
              </button>
              <button
                type="button"
                onClick={() => setCreatingFolder(false)}
                className="h-8 rounded-md px-3 text-sm hover:bg-hover"
              >
                {t("common.cancel", "取消")}
              </button>
            </div>
          ) : null}

          {error ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
            <nav
              data-testid="cloud-file-breadcrumbs"
              aria-label={t("todo.file_path", "文件路径")}
              className="flex h-11 items-center gap-0.5 border-b border-border px-3"
            >
              {breadcrumbs.map((breadcrumb, index) => (
                <span
                  key={breadcrumb.key}
                  className="flex min-w-0 items-center"
                >
                  {index > 0 ? (
                    <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setCreatingFolder(false);
                      navigateTo(breadcrumb.location);
                    }}
                    className="max-w-48 truncate rounded-md px-2 py-1 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
                  >
                    {breadcrumb.name}
                  </button>
                </span>
              ))}
            </nav>

            <div className="grid h-9 grid-cols-[minmax(0,1fr)_150px_90px_132px] items-center bg-muted/30 px-4 text-xs text-text-muted">
              <span>{t("todo.file_name", "名称")}</span>
              <span>{t("todo.file_updated_at", "更新时间")}</span>
              <span>{t("todo.file_size", "大小")}</span>
              <span />
            </div>

            {entries.length === 0 ? (
              <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-text-muted">
                <FolderIcon className="h-6 w-6" />
                <span>{t("todo.folder_empty", "此文件夹为空")}</span>
              </div>
            ) : (
              entries.map((entry) => {
                const sharedEntry =
                  entry.kind === "shared-file"
                    ? entry.file
                    : entry.kind === "folder"
                      ? entry.sharedFolder
                      : undefined;
                const deliveryEntry =
                  entry.kind === "delivery-file" ? entry.file : undefined;
                const updatedAt =
                  entry.kind === "folder"
                    ? entry.updatedAt
                    : entry.kind === "shared-file"
                      ? entry.file.updated_at
                      : entry.file.delivered_at;
                const size =
                  entry.kind === "shared-file"
                    ? formatCollaborationFileSize(entry.file.size_bytes)
                    : entry.kind === "delivery-file"
                      ? formatCollaborationFileSize(entry.file.size_bytes)
                      : "—";

                return (
                  <div
                    key={entry.key}
                    data-testid={
                      entry.kind === "delivery-file"
                        ? `delivery-file-${entry.file.asset_id}`
                        : `cloud-file-browser-entry-${entry.key}`
                    }
                    className="group grid min-h-12 grid-cols-[minmax(0,1fr)_150px_90px_132px] items-center border-t border-border px-4 text-xs transition-colors hover:bg-muted/50"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      {entry.kind === "folder" ? (
                        <FolderIcon className="h-4 w-4 shrink-0 text-text-muted" />
                      ) : (
                        <FileIcon className="h-4 w-4 shrink-0 text-text-muted" />
                      )}
                      {sharedEntry && editingFileId === sharedEntry.id ? (
                        <input
                          autoFocus
                          data-testid={`cloud-file-path-${sharedEntry.id}`}
                          value={editingPath}
                          onChange={(event) =>
                            setEditingPath(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter")
                              void moveFile(sharedEntry);
                            if (event.key === "Escape") setEditingFileId(null);
                          }}
                          className="h-7 min-w-0 flex-1 rounded border border-focus bg-background px-2 outline-none"
                        />
                      ) : entry.kind === "folder" ? (
                        <button
                          type="button"
                          aria-label={entry.name}
                          onClick={() => {
                            setCreatingFolder(false);
                            navigateTo(entry.location);
                          }}
                          className="flex min-w-0 flex-col items-start text-left"
                        >
                          <span className="max-w-full truncate text-sm font-medium text-text-primary">
                            {entry.name}
                          </span>
                          <span className="max-w-full truncate text-xs text-text-muted">
                            {entry.description}
                          </span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          data-testid={
                            entry.kind === "shared-file"
                              ? `cloud-file-preview-${entry.file.id}`
                              : `delivery-file-preview-${entry.file.asset_id}`
                          }
                          onClick={() =>
                            entry.kind === "shared-file"
                              ? previewCloudFile(entry.file)
                              : previewDeliveryFile(entry.file)
                          }
                          className="min-w-0 truncate text-left text-sm font-medium text-text-primary hover:underline"
                        >
                          {entry.name}
                        </button>
                      )}
                    </div>
                    <span className="text-text-muted">
                      {updatedAt?.slice(0, 10) ?? "—"}
                    </span>
                    <span className="text-text-muted">{size}</span>
                    <span className="flex justify-end gap-1">
                      {sharedEntry
                        ? withTooltip(
                            t(
                              "todo.rename_or_move_file",
                              "重命名或移动 {{path}}",
                              {
                                path: sharedEntry.path,
                              },
                            ),
                            <button
                              type="button"
                              data-testid={`cloud-file-rename-${sharedEntry.id}`}
                              onClick={() => {
                                setEditingFileId(sharedEntry.id);
                                setEditingPath(sharedEntry.path);
                              }}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted"
                              aria-label={t(
                                "todo.rename_or_move_file",
                                "重命名或移动 {{path}}",
                                {
                                  path: sharedEntry.path,
                                },
                              )}
                            >
                              <PencilIcon className="h-3.5 w-3.5" />
                            </button>,
                          )
                        : null}
                      {sharedEntry?.kind === "file" ? (
                        <>
                          {withTooltip(
                            t("todo.preview_file_path", "预览 {{path}}", {
                              path: sharedEntry.path,
                            }),
                            <button
                              type="button"
                              data-testid={`cloud-file-open-${sharedEntry.id}`}
                              onClick={() => previewCloudFile(sharedEntry)}
                              className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                              aria-label={t(
                                "todo.preview_file_path",
                                "预览 {{path}}",
                                {
                                  path: sharedEntry.path,
                                },
                              )}
                            >
                              <EyeIcon className="h-3.5 w-3.5" />
                            </button>,
                          )}
                          {withTooltip(
                            t("todo.download_file_path", "下载 {{path}}", {
                              path: sharedEntry.path,
                            }),
                            <button
                              type="button"
                              data-testid={`cloud-file-download-${sharedEntry.id}`}
                              disabled={downloadingFileId === sharedEntry.id}
                              onClick={() =>
                                void downloadFile(
                                  sharedEntry.id,
                                  downloadName(sharedEntry.path),
                                  () => api.downloadFile(sharedEntry.id),
                                ).catch(() => undefined)
                              }
                              className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
                              aria-label={t(
                                "todo.download_file_path",
                                "下载 {{path}}",
                                {
                                  path: sharedEntry.path,
                                },
                              )}
                            >
                              <DownloadIcon className="h-3.5 w-3.5" />
                            </button>,
                          )}
                        </>
                      ) : null}
                      {deliveryEntry ? (
                        <>
                          {withTooltip(
                            t(
                              "todo.preview_delivery_file",
                              "预览交付文件 {{path}}",
                              {
                                path: deliveryEntry.relative_path,
                              },
                            ),
                            <button
                              type="button"
                              data-testid={`delivery-file-open-${deliveryEntry.asset_id}`}
                              onClick={() => previewDeliveryFile(deliveryEntry)}
                              className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                              aria-label={t(
                                "todo.preview_delivery_file",
                                "预览交付文件 {{path}}",
                                {
                                  path: deliveryEntry.relative_path,
                                },
                              )}
                            >
                              <EyeIcon className="h-3.5 w-3.5" />
                            </button>,
                          )}
                          {withTooltip(
                            t(
                              "todo.download_delivery_file",
                              "下载交付文件 {{path}}",
                              {
                                path: deliveryEntry.relative_path,
                              },
                            ),
                            <button
                              type="button"
                              data-testid={`delivery-file-download-${deliveryEntry.asset_id}`}
                              disabled={
                                downloadingFileId === deliveryEntry.asset_id
                              }
                              onClick={() =>
                                void downloadFile(
                                  deliveryEntry.asset_id,
                                  deliveryEntry.display_name,
                                  () =>
                                    api.downloadDeliveryFile(
                                      deliveryEntry.asset_id,
                                    ),
                                ).catch(() => undefined)
                              }
                              className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
                              aria-label={t(
                                "todo.download_delivery_file",
                                "下载交付文件 {{path}}",
                                { path: deliveryEntry.relative_path },
                              )}
                            >
                              <DownloadIcon className="h-3.5 w-3.5" />
                            </button>,
                            "end",
                          )}
                        </>
                      ) : null}
                      {sharedEntry
                        ? withTooltip(
                            t("todo.delete_file_path", "删除 {{path}}", {
                              path: sharedEntry.path,
                            }),
                            <button
                              type="button"
                              data-testid={`cloud-file-delete-${sharedEntry.id}`}
                              onClick={() => void deleteFile(sharedEntry)}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-destructive"
                              aria-label={t(
                                "todo.delete_file_path",
                                "删除 {{path}}",
                                {
                                  path: sharedEntry.path,
                                },
                              )}
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </button>,
                            "end",
                          )
                        : null}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          {location.scope === "root" && showsTaskAttachments ? (
            <section className="mt-6">
              <div className="flex items-baseline gap-2.5">
                <h3 className="text-base font-semibold text-text-primary">
                  {t("todo.task_attachments", "任务附件")}
                </h3>
                <span className="text-xs text-text-muted">
                  {t("todo.task_attachments_description", "")}
                </span>
              </div>
              <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
                <div className="grid h-10 grid-cols-[240px_minmax(0,1fr)_120px_120px_80px_80px] items-center bg-muted/30 px-4 text-xs text-text-muted">
                  <span>{t("todo.task_attachment_task", "任务")}</span>
                  <span>{t("todo.task_attachment_name", "名称")}</span>
                  <span>{t("todo.task_attachment_type", "类型")}</span>
                  <span>
                    {t("todo.task_attachment_uploaded_at", "上传时间")}
                  </span>
                  <span>{t("todo.task_attachment_size", "大小")}</span>
                  <span />
                </div>
                {taskAttachments.length === 0 ? (
                  <div className="flex h-24 items-center justify-center text-sm text-text-muted">
                    {t("todo.task_attachments_empty", "暂无任务附件")}
                  </div>
                ) : (
                  taskAttachments.map((entry) => (
                    <div
                      key={entry.id}
                      data-testid={`task-attachment-${entry.id}`}
                      className="grid min-h-12 grid-cols-[240px_minmax(0,1fr)_120px_120px_80px_80px] items-center border-t border-border px-4 text-xs transition-colors hover:bg-muted/60"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 font-mono text-text-muted">
                          {entry.loop_item_id}
                        </span>
                        <span className="truncate text-text-primary">
                          {entry.loop_item_title}
                        </span>
                      </span>
                      <span className="flex min-w-0 items-center gap-2 text-text-primary">
                        <FileIcon className="h-4 w-4 shrink-0 text-text-muted" />
                        <span className="truncate">{entry.display_name}</span>
                      </span>
                      <span className="truncate text-text-muted">
                        {entry.content_type ||
                          t("todo.task_attachment_file", "文件")}
                      </span>
                      <span className="text-text-muted">
                        {entry.created_at.slice(0, 10)}
                      </span>
                      <span className="text-text-muted">
                        {formatCollaborationFileSize(entry.size_bytes)}
                      </span>
                      <span className="flex justify-end gap-1">
                        {withTooltip(
                          t("todo.preview_task_attachment", "预览 {{name}}", {
                            name: entry.display_name,
                          }),
                          <button
                            type="button"
                            data-testid={`task-attachment-preview-${entry.id}`}
                            onClick={() => previewTaskAttachment(entry)}
                            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                            aria-label={t(
                              "todo.preview_task_attachment",
                              "预览 {{name}}",
                              {
                                name: entry.display_name,
                              },
                            )}
                          >
                            <EyeIcon className="h-3.5 w-3.5" />
                          </button>,
                        )}
                        {withTooltip(
                          t("todo.open_task_attachment", "打开 {{name}}", {
                            name: entry.display_name,
                          }),
                          <button
                            type="button"
                            data-testid={`task-attachment-open-${entry.id}`}
                            onClick={() => void openTaskAttachment(entry)}
                            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                            aria-label={t(
                              "todo.open_task_attachment",
                              "打开 {{name}}",
                              {
                                name: entry.display_name,
                              },
                            )}
                          >
                            <DownloadIcon className="h-3.5 w-3.5" />
                          </button>,
                        )}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {previewTarget ? (
        <aside
          data-testid="cloud-file-preview-sidebar"
          className="flex w-[480px] shrink-0 flex-col border-l border-border bg-background"
        >
          <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
            <span
              data-testid="cloud-file-preview-title"
              className="min-w-0 truncate text-sm font-medium text-text-primary"
            >
              {previewTarget.title}
            </span>
            <button
              type="button"
              data-testid="cloud-file-preview-close"
              onClick={() => {
                previewRequestSequence.current += 1;
                setPreviewTarget(null);
              }}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary"
              aria-label={t("todo.close_preview", "关闭预览")}
            >
              <XIcon className="h-4 w-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            <PreviewComponent
              file={previewText}
              binaryFile={previewBinary}
              loading={previewLoading}
              error={previewError}
              onRetry={() => previewTarget && void loadPreview(previewTarget)}
            />
          </div>
        </aside>
      ) : null}
    </div>
  );
}
