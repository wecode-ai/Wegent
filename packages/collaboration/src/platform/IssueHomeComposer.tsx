import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
  type ReactNode,
} from "react";
import type { Attachment } from "@wegent/chat-core/runtime";
import { ChevronDown } from "lucide-react";
import type { ComposerExternalMentionCandidate } from "../composer/composerAutocompleteInputTypes";
import {
  ProjectComposerBody,
  ComposerToolbar,
  type ComposerInputHandle,
} from "../composer";
import { ComposerAutocompleteInput } from "../composer/ComposerAutocompleteInput";
import {
  ComposerAttachmentBadges,
  type ComposerAttachment,
} from "../issue-detail/ComposerAttachmentBadges";
import type { AttachmentImageServices } from "../issue-detail/AttachmentImageView";
import { ComposerErrorBanner } from "../composer/ComposerErrorBanner";
import type { CollaborationTranslate } from "../i18n";
import type {
  CollaborationMember,
  CollaborationProject,
  CollaborationWorkspace,
  CollaborationIssue,
} from "../types";
import { parseComposerMentions } from "../composer/composerMentions";
import { IssueOwnerPicker } from "./IssueOwnerPicker";
import { issueHomeOwners, type IssueHomeOwner } from "./issueHomeOwners";
import type { CollaborationGroup } from "../types";
import type { WorkspaceProjectAgent } from "../ports/SharedWorkspaceApi";

const emptyAgents: WorkspaceProjectAgent[] = [];
const emptyGroups: CollaborationGroup[] = [];

type PendingFile = Attachment & ComposerAttachment & { id: number; file: File };
export interface IssueHomeTaskComposerProps {
  projects: CollaborationProject[];
  workspaces?: CollaborationWorkspace[];
  projectId: string;
  onSelectProject(id: string): void;
  projectLabel: string;
  ref: Ref<ComposerInputHandle>;
  value: string;
  onChange(value: string): void;
  onDraftChange?(value: string): void;
  ownerControl?: ReactNode;
  environmentNotice?: ReactNode;
  onSubmit(
    value: string,
    standInDeviceId?: string,
    standInId?: string,
  ): Promise<boolean>;
  disabled: boolean;
  placeholder: string;
  error: string | null;
  members: ComposerExternalMentionCandidate[];
  attachments: Attachment[];
  onFileSelect(files: File | File[]): void;
  onRemoveAttachment(id: number): void;
}
const images: AttachmentImageServices<PendingFile> = {
  identity: (item) => String(item.id),
  async load(item) {
    const url = URL.createObjectURL(item.file);
    return { url, release: () => URL.revokeObjectURL(url) };
  },
  async download(_item, url, filename) {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  },
};

/** Issue creation uses the same editor, autocomplete, surface and toolbar as Tasks. */
export function IssueHomeComposer({
  ref,
  value,
  onChange,
  onSubmit,
  pending,
  members,
  agents = emptyAgents,
  groups = emptyGroups,
  issues = [],
  projects,
  workspaces,
  projectId,
  onSelectProject,
  translate,
  placeholder,
  projectLabel,
  error,
  environmentNotice,
  renderTaskComposer,
}: {
  ref: Ref<ComposerInputHandle>;
  value: string;
  onChange(value: string): void;
  onSubmit(
    content: string,
    owner: IssueHomeOwner | null,
    files: File[],
    standInDeviceId?: string,
    standInId?: string,
  ): Promise<boolean>;
  pending: boolean;
  members: CollaborationMember[];
  agents?: WorkspaceProjectAgent[];
  groups?: CollaborationGroup[];
  issues?: CollaborationIssue[];
  projects: CollaborationProject[];
  workspaces?: CollaborationWorkspace[];
  projectId: string;
  onSelectProject(id: string): void;
  translate: CollaborationTranslate;
  placeholder: string;
  projectLabel: string;
  memberLabel: string;
  error: string | null;
  environmentNotice?: ReactNode;
  renderTaskComposer?(props: IssueHomeTaskComposerProps): ReactNode;
}) {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [referenceError, setReferenceError] = useState(false);
  const [automaticOwner, setAutomaticOwner] = useState<string | null>(null);
  const [ownerOverride, setOwnerOverride] = useState<{
    projectId: string;
    id: string | null;
  } | null>(null);
  const nextId = useRef(0);
  const previews = useRef(new Set<string>());
  useEffect(
    () => () => {
      for (const url of previews.current) URL.revokeObjectURL(url);
    },
    [],
  );
  const candidates = useMemo(
    () => issueHomeOwners(projectId, members, agents, groups, translate),
    [members, agents, groups, projectId, translate],
  );
  const addFiles = (input: File | File[]) => {
    const batch = (Array.isArray(input) ? input : [input]).map((file) => {
      const preview = file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined;
      if (preview) previews.current.add(preview);
      return {
        id: ++nextId.current,
        file,
        filename: file.name,
        mime_type: file.type,
        file_extension: file.name.includes(".")
          ? `.${file.name.split(".").pop()}`
          : "",
        file_size: file.size,
        status: "ready" as const,
        created_at: new Date().toISOString(),
        local_preview_url: preview,
      };
    });
    setFiles((current) => [...current, ...batch]);
  };
  const removeFile = (id: number | string) =>
    setFiles((current) => current.filter((file) => file.id !== id));
  const issueCandidates = issues.map((issue) => ({
    id: `issue-${issue.id}`,
    type: "issue" as const,
    title: `#${issue.sequence_number} ${issue.title}`,
    metaLabel: "Issue",
    reference: `[$#${issue.sequence_number} ${issue.title.replace(/[\[\]\n]/g, "")}](wework-issue://${encodeURIComponent(projectId)}/${encodeURIComponent(issue.id)})`,
    testId: `collaboration-home-mention-issue-${issue.id}`,
    searchAliases: [issue.title, String(issue.sequence_number)],
  }));
  const firstMentionedMember = (draft: string) => {
    for (const mention of parseComposerMentions(draft)) {
      const member = candidates.find(
        (candidate) => candidate.reference === mention.reference,
      );
      if (member) return member.id;
    }
    return null;
  };
  const draftChanged = (draft: string) =>
    setAutomaticOwner(firstMentionedMember(draft));
  const ownerId =
    ownerOverride?.projectId === projectId ? ownerOverride.id : automaticOwner;
  const ownerControl = (
    <IssueOwnerPicker
      owners={candidates}
      value={ownerId}
      disabled={pending}
      translate={translate}
      onChange={(id) => setOwnerOverride({ projectId, id })}
    />
  );
  const selectedProject = projects.find((project) => project.id === projectId);
  useEffect(() => {
    setAutomaticOwner(firstMentionedMember(value));
  }, [value, projectId, candidates]);
  const submit = async (
    draft: string,
    standInDeviceId?: string,
    standInId?: string,
  ) => {
    const mentions = parseComposerMentions(draft);
    if (
      mentions.some(
        (mention) =>
          /\]\(wework-(member|agent|group|issue):\/\//.test(
            mention.reference,
          ) &&
          ![...candidates, ...issueCandidates].some(
            (candidate) => candidate.reference === mention.reference,
          ),
      )
    ) {
      setReferenceError(true);
      return false;
    }
    setReferenceError(false);
    const selectedOwner =
      ownerOverride?.projectId === projectId
        ? ownerOverride.id
        : firstMentionedMember(draft);
    if (
      selectedOwner &&
      !candidates.some((candidate) => candidate.id === selectedOwner)
    ) {
      setReferenceError(true);
      return false;
    }
    let content = draft;
    for (const mention of [...mentions].reverse()) {
      if (/\]\(wework-(member|agent|group):\/\//.test(mention.reference)) {
        content =
          content.slice(0, mention.start) +
          mention.name +
          content.slice(mention.end);
      }
    }
    return onSubmit(
      content.trim(),
      candidates.find((candidate) => candidate.id === selectedOwner)?.owner ??
        null,
      files.map((item) => item.file),
      ...(standInDeviceId
        ? [standInDeviceId, ...(standInId ? [standInId] : [])]
        : []),
    );
  };
  const projectSelector = (
    <div className="flex min-h-10 items-center justify-center rounded-t-[26px] bg-surface px-4">
      <label className="relative inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-text-secondary hover:bg-background/70 hover:text-text-primary keyboard:focus-within:ring-2 keyboard:focus-within:ring-primary/30">
        <span className="sr-only">{projectLabel}</span>
        <span
          data-testid="collaboration-issue-project-label"
          className="max-w-48 truncate text-text-primary"
        >
          {selectedProject?.name ?? projectLabel}
        </span>
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0" />
        <select
          data-testid="collaboration-issue-project"
          aria-label={projectLabel}
          value={projectId}
          disabled={pending}
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0 disabled:cursor-default"
          onChange={(event) => onSelectProject(event.target.value)}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
  if (renderTaskComposer)
    return (
      <>
        {renderTaskComposer({
          projects,
          workspaces,
          projectId,
          onSelectProject,
          projectLabel,
          ref,
          value,
          onChange,
          onDraftChange: draftChanged,
          ownerControl,
          environmentNotice,
          onSubmit: submit,
          disabled: pending,
          placeholder,
          error: referenceError
            ? translate(
                "issue_creation.invalid_reference",
                "The project changed. Remove or reselect mentions before creating the Issue.",
              )
            : error,
          members: [...candidates, ...issueCandidates],
          attachments: files,
          onFileSelect: addFiles,
          onRemoveAttachment: removeFile,
        })}
      </>
    );
  return (
    <>
      <ComposerErrorBanner error={error} />
      {environmentNotice}
      <ProjectComposerBody
        workBar={projectSelector}
        ref={ref}
        translate={translate}
        value={value}
        onChange={(draft) => {
          draftChanged(draft);
          onChange(draft);
        }}
        onSubmit={(value) => submit(value)}
        disabled={pending}
        requireText
        isModelSelectionReady
        placeholder={placeholder}
        inputTestId="collaboration-home-issue-content"
        attachments={[]}
        uploadingCount={0}
        attachmentErrorCount={0}
        onFileSelect={addFiles}
        onRemoveAttachment={removeFile}
        renderAttachments={() => (
          <ComposerAttachmentBadges
            attachments={files}
            uploadingFiles={new Map()}
            errors={new Map()}
            onRemoveAttachment={removeFile}
            imageServices={images}
            labels={{
              pastedText: translate("todo.pasted_text_attachment"),
              addingText: translate("todo.adding_pasted_text_attachment"),
              showText: translate("todo.show_text_attachment"),
              appshot: translate("todo.appshot_attachment"),
            }}
          />
        )}
        renderEditor={(props) => (
          <ComposerAutocompleteInput
            {...props}
            translate={translate}
            mentionScope="external"
            externalMentionCandidates={[...candidates, ...issueCandidates]}
          />
        )}
        renderToolbar={(props) => (
          <ComposerToolbar
            {...props}
            translate={translate}
            disabled={pending}
            showExecutionTools={false}
            models={[]}
            selectedModel={null}
            selectedModelOptions={{}}
            isModelSelectionReady
            renderModelSelector={() => null}
            onSelectModel={() => {}}
            onSelectModelOption={() => {}}
            onFileSelect={addFiles}
            sendButtonTestId="collaboration-home-create-issue"
            leadingContext={ownerControl}
          />
        )}
      />
    </>
  );
}
