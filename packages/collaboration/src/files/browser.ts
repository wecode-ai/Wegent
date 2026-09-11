import type {
  CollaborationDeliveryFile,
  CollaborationFilesTranslate,
  CollaborationProjectFile,
} from "./types";

export type CollaborationFileBrowserLocation =
  | { scope: "root" }
  | { scope: "shared"; path: string[] }
  | { scope: "deliveries"; itemIds: string[]; assetPath: string[] };

export type CollaborationFileBrowserEntry =
  | {
      kind: "folder";
      key: string;
      name: string;
      description: string;
      location: CollaborationFileBrowserLocation;
      updatedAt: string | null;
      sharedFolder?: CollaborationProjectFile;
    }
  | {
      kind: "shared-file";
      key: string;
      name: string;
      file: CollaborationProjectFile;
    }
  | {
      kind: "delivery-file";
      key: string;
      name: string;
      file: CollaborationDeliveryFile;
    };

type FolderEntry = Extract<CollaborationFileBrowserEntry, { kind: "folder" }>;

export interface CollaborationFileBrowserBreadcrumb {
  key: string;
  name: string;
  location: CollaborationFileBrowserLocation;
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function startsWith<T>(values: T[], prefix: T[]): boolean {
  return prefix.every((value, index) => values[index] === value);
}

function deliveryItemPath(file: CollaborationDeliveryFile) {
  return file.loop_item_path.length
    ? file.loop_item_path
    : [{ id: file.loop_item_id, title: file.loop_item_title }];
}

function sortEntries(
  entries: CollaborationFileBrowserEntry[],
): CollaborationFileBrowserEntry[] {
  return entries.sort((left, right) => {
    if (left.kind === "folder" && right.kind !== "folder") return -1;
    if (left.kind !== "folder" && right.kind === "folder") return 1;
    return left.name.localeCompare(right.name, "zh-CN");
  });
}

function rootEntries(
  sharedFiles: CollaborationProjectFile[],
  deliveryFiles: CollaborationDeliveryFile[],
  t: CollaborationFilesTranslate,
): CollaborationFileBrowserEntry[] {
  const issueCount = new Set(
    deliveryFiles.map((file) => deliveryItemPath(file)[0]?.id).filter(Boolean),
  ).size;
  return [
    {
      kind: "folder",
      key: "root:shared",
      name: t("todo.shared_files"),
      description: t("todo.file_count", undefined, {
        count: sharedFiles.filter((file) => file.kind === "file").length,
      }),
      location: { scope: "shared", path: [] },
      updatedAt: null,
    },
    {
      kind: "folder",
      key: "root:issues",
      name: "Issues",
      description: t("todo.delivery_issue_count", undefined, {
        count: issueCount,
      }),
      location: { scope: "deliveries", itemIds: [], assetPath: [] },
      updatedAt: null,
    },
  ];
}

function sharedEntries(
  path: string[],
  files: CollaborationProjectFile[],
  t: CollaborationFilesTranslate,
): CollaborationFileBrowserEntry[] {
  const folders = new Map<string, FolderEntry>();
  const entries: CollaborationFileBrowserEntry[] = [];
  for (const file of files) {
    const parts = splitPath(file.path);
    if (!startsWith(parts, path) || parts.length <= path.length) continue;
    const name = parts[path.length];
    const childPath = [...path, name];
    if (parts.length > path.length + 1 || file.kind === "folder") {
      const key = childPath.join("/");
      const current = folders.get(key);
      if (!current || file.path === key) {
        folders.set(key, {
          kind: "folder",
          key: `shared-folder:${key}`,
          name,
          description: t("todo.folder"),
          location: { scope: "shared", path: childPath },
          updatedAt:
            file.path === key ? file.updated_at : (current?.updatedAt ?? null),
          sharedFolder:
            file.path === key && file.kind === "folder" ? file : undefined,
        });
      }
      continue;
    }
    entries.push({
      kind: "shared-file",
      key: `shared-file:${file.id}`,
      name,
      file,
    });
  }
  return sortEntries([...folders.values(), ...entries]);
}

function deliveryEntries(
  location: Extract<CollaborationFileBrowserLocation, { scope: "deliveries" }>,
  files: CollaborationDeliveryFile[],
  t: CollaborationFilesTranslate,
): CollaborationFileBrowserEntry[] {
  const folders = new Map<string, FolderEntry>();
  const entries: CollaborationFileBrowserEntry[] = [];
  for (const file of files) {
    const itemPath = deliveryItemPath(file);
    const itemIds = itemPath.map((item) => item.id);
    if (!startsWith(itemIds, location.itemIds)) continue;
    if (itemIds.length > location.itemIds.length) {
      if (location.assetPath.length > 0) continue;
      const item = itemPath[location.itemIds.length];
      const childIds = [...location.itemIds, item.id];
      folders.set(`item:${item.id}`, {
        kind: "folder",
        key: `delivery-item:${childIds.join("/")}`,
        name: item.title,
        description:
          location.itemIds.length === 0
            ? t("todo.issue_with_id", undefined, { id: item.id })
            : t("todo.task_with_id", undefined, { id: item.id }),
        location: { scope: "deliveries", itemIds: childIds, assetPath: [] },
        updatedAt: file.delivered_at,
      });
      continue;
    }

    const relativeParts = splitPath(file.relative_path);
    const directoryParts = relativeParts.slice(0, -1);
    if (!startsWith(directoryParts, location.assetPath)) continue;
    if (directoryParts.length > location.assetPath.length) {
      const name = directoryParts[location.assetPath.length];
      const childPath = [...location.assetPath, name];
      folders.set(`asset:${childPath.join("/")}`, {
        kind: "folder",
        key: `delivery-path:${location.itemIds.join("/")}:${childPath.join("/")}`,
        name,
        description: t("todo.delivery_directory"),
        location: {
          scope: "deliveries",
          itemIds: location.itemIds,
          assetPath: childPath,
        },
        updatedAt: file.delivered_at,
      });
      continue;
    }
    entries.push({
      kind: "delivery-file",
      key: `delivery-file:${file.asset_id}`,
      name: relativeParts.at(-1) || file.display_name,
      file,
    });
  }
  return sortEntries([...folders.values(), ...entries]);
}

export function collaborationFileBrowserEntries(
  location: CollaborationFileBrowserLocation,
  sharedFiles: CollaborationProjectFile[],
  deliveryFiles: CollaborationDeliveryFile[],
  t: CollaborationFilesTranslate,
): CollaborationFileBrowserEntry[] {
  if (location.scope === "root")
    return rootEntries(sharedFiles, deliveryFiles, t);
  if (location.scope === "shared")
    return sharedEntries(location.path, sharedFiles, t);
  return deliveryEntries(location, deliveryFiles, t);
}

export function collaborationFileBrowserBreadcrumbs(
  location: CollaborationFileBrowserLocation,
  deliveryFiles: CollaborationDeliveryFile[],
  t: CollaborationFilesTranslate,
): CollaborationFileBrowserBreadcrumb[] {
  const breadcrumbs: CollaborationFileBrowserBreadcrumb[] = [
    { key: "root", name: t("todo.files_title"), location: { scope: "root" } },
  ];
  if (location.scope === "root") return breadcrumbs;
  if (location.scope === "shared") {
    breadcrumbs.push({
      key: "shared",
      name: t("todo.shared_files"),
      location: { scope: "shared", path: [] },
    });
    location.path.forEach((name, index) => {
      breadcrumbs.push({
        key: `shared:${location.path.slice(0, index + 1).join("/")}`,
        name,
        location: { scope: "shared", path: location.path.slice(0, index + 1) },
      });
    });
    return breadcrumbs;
  }

  breadcrumbs.push({
    key: "issues",
    name: "Issues",
    location: { scope: "deliveries", itemIds: [], assetPath: [] },
  });
  const matching = deliveryFiles.map(deliveryItemPath).find((path) =>
    startsWith(
      path.map((item) => item.id),
      location.itemIds,
    ),
  );
  location.itemIds.forEach((id, index) => {
    breadcrumbs.push({
      key: `delivery-item:${id}`,
      name: matching?.[index]?.title ?? id,
      location: {
        scope: "deliveries",
        itemIds: location.itemIds.slice(0, index + 1),
        assetPath: [],
      },
    });
  });
  location.assetPath.forEach((name, index) => {
    breadcrumbs.push({
      key: `delivery-path:${location.assetPath.slice(0, index + 1).join("/")}`,
      name,
      location: {
        scope: "deliveries",
        itemIds: location.itemIds,
        assetPath: location.assetPath.slice(0, index + 1),
      },
    });
  });
  return breadcrumbs;
}
