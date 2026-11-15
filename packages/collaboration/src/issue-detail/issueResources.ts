import type { SharedWorkspaceAttachmentsApi } from "../ports/SharedWorkspaceApi";
import type { CollaborationAttachment } from "../types";
import {
  classifyMarkdownLink,
  getMarkdownAttachmentId,
} from "../markdown/assistantMarkdownLinks";
import { normalizeAttachmentBlob } from "../files/preview";

export interface IssueResources {
  open?(attachment: CollaborationAttachment): void | Promise<void>;
  resolve(href: string, label?: string): Promise<CollaborationAttachment>;
  read(
    href: string,
    label?: string,
  ): Promise<{ attachment: CollaborationAttachment; blob: Blob }>;
}

/** Resolve every file reference against one Issue; never read an executor path on the viewer's device. */
export function createIssueResources(
  api: SharedWorkspaceAttachmentsApi,
  issueId: string,
  projectId?: string,
): IssueResources {
  let listing: Promise<CollaborationAttachment[]> | null = null;
  const list = () =>
    (listing ??= api.list(issueId).finally(() => {
      listing = null;
    }));
  async function resolve(href: string, label?: string) {
    const id = getMarkdownAttachmentId(href);
    const target = classifyMarkdownLink(href);
    if (!id && (target.kind !== "file" || target.isDirectory))
      throw new Error("Not an Issue file reference");
    const basename =
      target.kind === "file"
        ? target.path.replace(/\\/g, "/").split("/").pop()
        : undefined;
    const matches = (await list()).filter((attachment) =>
      id
        ? attachment.id === id
        : attachment.display_name === label ||
          attachment.display_name === basename,
    );
    if (matches.length !== 1)
      throw new Error("Issue attachment is missing or ambiguous");
    return matches[0];
  }
  return {
    resolve,
    async read(href, label) {
      const attachment = await resolve(href, label);
      const blob = normalizeAttachmentBlob(
        await (projectId
          ? api.read(attachment.id, { projectId, issueId })
          : api.read(attachment.id)),
        attachment.display_name,
        attachment.content_type,
      );
      return { attachment, blob };
    },
  };
}
