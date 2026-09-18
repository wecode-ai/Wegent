import { useMarkdownServices } from "../../markdown/MarkdownServices";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useConversationTranslation } from "../ConversationTranslation";
import { terminalOutputToText } from "@wegent/chat-core/terminal-text";
import type { ToolBlock } from "./types";
import {
  localMarkdownImagePath,
  resolveDirectMarkdownImageSrc,
} from "../../markdown/assistantMarkdownLinks";
import { isWebSearchToolName } from "./toolBlockActivity";
import {
  getFileInputPath,
  getFileInputPaths,
  getInputField,
  isCommandToolName,
  isFileCreateToolName,
  isFileEditToolName,
  isGuidanceToolName,
  isImageGenerationToolName,
  isImageViewToolName,
  isFileReadToolName,
  isNodeReplToolName,
} from "./toolBlockKinds";
import { WebSearchActivityRows } from "./WebSearchSources";
import { getWebSearchActivityItems } from "./webSearchActivity";
import { truncate } from "./toolBlockText";

export function renderBlockDetail(block: ToolBlock) {
  const name = block.toolName.toLowerCase();

  if (isCommandToolName(name)) {
    return <BashBlockDetail block={block} />;
  }
  if (isFileCreateToolName(name)) {
    return <FileWriteDetail block={block} />;
  }
  if (isFileEditToolName(name)) {
    return <FileEditDetail block={block} />;
  }
  if (isWebSearchToolName(name)) {
    return <WebSearchBlockDetail block={block} />;
  }
  if (isImageViewToolName(name)) {
    return <ImageViewBlockDetail block={block} />;
  }
  if (isGuidanceToolName(name)) {
    return null;
  }

  return <GenericToolBlockDetail block={block} />;
}

export function hasBlockDetail(block: ToolBlock): boolean {
  const name = block.toolName.toLowerCase();
  if (isGuidanceToolName(name) || isImageGenerationToolName(name)) return false;
  if (
    isCommandToolName(name) ||
    isFileCreateToolName(name) ||
    isFileEditToolName(name) ||
    isWebSearchToolName(name) ||
    isImageViewToolName(name)
  ) {
    return true;
  }
  return block.toolInput !== undefined || block.toolOutput !== undefined;
}

function GenericToolBlockDetail({ block }: { block: ToolBlock }) {
  const { t } = useConversationTranslation();
  const inputText = stringifyToolValue(block.toolInput);
  const outputText = stringifyToolValue(block.toolOutput);
  const isJavaScript = isNodeReplToolName(block.toolName);
  const code = isJavaScript
    ? getInputField(block, "code", "javascript", "source")
    : undefined;

  return (
    <div
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface"
      data-testid="generic-tool-block-detail"
    >
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
        <span className="min-w-0 truncate font-mono text-xs text-text-secondary">
          {block.toolName}
        </span>
        {isJavaScript ? (
          <span className="shrink-0 text-xs text-text-muted">JavaScript</span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-3 p-3">
        {code ? (
          <ToolDetailSection
            label={t("tool_activity.tool_input")}
            content={code}
            testId="generic-tool-input"
          />
        ) : inputText ? (
          <ToolDetailSection
            label={t("tool_activity.tool_input")}
            content={inputText}
            testId="generic-tool-input"
          />
        ) : null}
        {outputText ? (
          <ToolDetailSection
            label={t("tool_activity.tool_output")}
            content={outputText}
            testId="generic-tool-output"
          />
        ) : block.status === "done" ? (
          <p className="text-xs text-text-muted">
            {t("tool_activity.tool_no_output")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ToolDetailSection({
  label,
  content,
  testId,
}: {
  label: string;
  content: string;
  testId: string;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-1 text-xs text-text-muted">{label}</div>
      <pre
        className="max-h-48 max-w-full overflow-auto rounded-md bg-code-bg px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-text-secondary"
        data-testid={testId}
      >
        {content}
      </pre>
    </section>
  );
}

function stringifyToolValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ImageViewBlockDetail({ block }: { block: ToolBlock }) {
  const { t } = useConversationTranslation();
  const source = getImageViewSource(block);
  const resolvedSource = useResolvedImageViewSource(source);

  if (!resolvedSource) return null;

  return (
    <div
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface"
      data-testid="image-view-block-detail"
    >
      <img
        src={resolvedSource}
        alt={t("tool_activity.image_preview_alt")}
        className="max-h-96 w-full object-contain"
        data-testid="image-view-preview"
      />
    </div>
  );
}

function useResolvedImageViewSource(source?: string): string | null {
  const { readLocalFile } = useMarkdownServices();
  const localImagePath = useMemo(() => {
    if (!source || !readLocalFile) return null;
    return localMarkdownImagePath(source);
  }, [source, readLocalFile]);
  const [localImage, setLocalImage] = useState<{
    path: string;
    url: string;
  } | null>(null);

  useEffect(() => {
    if (!localImagePath || !readLocalFile) return undefined;

    let active = true;
    let objectUrl: string | null = null;
    void readLocalFile(localImagePath)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (active) setLocalImage({ path: localImagePath, url: objectUrl });
        else URL.revokeObjectURL(objectUrl);
      })
      .catch((error) => console.warn("Failed to read tool image", error));

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [localImagePath, readLocalFile]);

  if (localImagePath) {
    return localImage?.path === localImagePath ? localImage.url : null;
  }
  return source ? resolveDirectMarkdownImageSrc(source) : null;
}

function getImageViewSource(block: ToolBlock): string | undefined {
  const output = block.toolOutput;
  if (typeof output === "string" && isImageSource(output)) return output;
  if (isRecord(output)) {
    const directSource = getStringField(
      output,
      "image_url",
      "imageUrl",
      "url",
      "path",
    );
    if (directSource && isImageSource(directSource)) return directSource;

    const nestedImageUrl = output.image_url;
    if (isRecord(nestedImageUrl)) {
      const nestedSource = getStringField(nestedImageUrl, "url");
      if (nestedSource && isImageSource(nestedSource)) return nestedSource;
    }
  }

  return getInputField(block, "path", "file_path", "filePath");
}

function isImageSource(value: string): boolean {
  const source = value.trim();
  return (
    source.startsWith("data:image/") ||
    source.startsWith("blob:") ||
    source.startsWith("file://") ||
    /^https?:\/\//i.test(source) ||
    /^asset:/i.test(source) ||
    source.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(source)
  );
}

function WebSearchBlockDetail({ block }: { block: ToolBlock }) {
  const items = getWebSearchActivityItems([block]);

  if (items.length === 0) return null;

  return (
    <div data-testid="web-search-block-detail">
      <WebSearchActivityRows items={items} />
    </div>
  );
}

export function getWorkspaceFilePath(block: ToolBlock): string | undefined {
  const name = block.toolName.toLowerCase();
  if (
    !isFileReadToolName(name) &&
    !isFileCreateToolName(name) &&
    !isFileEditToolName(name)
  ) {
    return undefined;
  }
  return getFileInputPath(block);
}

function BashBlockDetail({ block }: { block: ToolBlock }) {
  const command = getInputField(block, "command", "cmd", "commandLine");
  const cwd = getInputField(block, "cwd", "workdir", "workingDirectory");
  const output = block.toolOutput;
  const rawOutputText = useMemo(
    () =>
      typeof output === "string"
        ? output
        : output
          ? JSON.stringify(output, null, 2)
          : "",
    [output],
  );
  const outputText = useMemo(
    () => terminalOutputToText(rawOutputText),
    [rawOutputText],
  );
  const outputRef = useRef<HTMLPreElement>(null);
  const isDone = block.status === "done";
  const isError = block.status === "error";
  const [copied, setCopied] = useState(false);

  useLayoutEffect(() => {
    const outputElement = outputRef.current;
    if (outputElement) outputElement.scrollTop = outputElement.scrollHeight;
  }, [outputText]);

  const handleCopy = () => {
    void navigator.clipboard.writeText(command ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="min-w-0 overflow-x-hidden rounded-lg bg-code-bg px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-text-muted">Shell</span>
        <button
          type="button"
          onClick={handleCopy}
          className="p-0.5 text-text-muted hover:text-text-secondary"
        >
          {copied ? (
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 13l4 4L19 7"
              />
            </svg>
          ) : (
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          )}
        </button>
      </div>
      {command && (
        <div className="overflow-x-auto font-mono text-xs leading-5 text-text-primary">
          <span className="text-text-muted">$ </span>
          {command}
        </div>
      )}
      {cwd && (
        <div
          className="mt-1 min-w-0 truncate font-mono text-xs text-text-muted"
          title={cwd}
        >
          cwd: {cwd}
        </div>
      )}
      {outputText && (
        <>
          <pre
            ref={outputRef}
            className="mt-1 max-h-48 max-w-full overflow-auto font-mono text-xs leading-5 text-text-secondary"
            data-testid="shell-tool-output"
          >
            {outputText}
          </pre>
        </>
      )}
      {(isDone || isError) && (
        <div className="mt-2 flex justify-end">
          {isDone && (
            <span className="flex items-center gap-1 text-xs text-text-muted">
              <svg
                className="h-3 w-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
              成功
            </span>
          )}
          {isError && <span className="text-xs text-red-500">失败</span>}
        </div>
      )}
    </div>
  );
}

function FileWriteDetail({ block }: { block: ToolBlock }) {
  const filePaths = getFileInputPaths(block);
  const content = getInputField(block, "content", "file_text", "fileText");
  return (
    <div className="min-w-0 space-y-1 overflow-x-hidden">
      {filePaths.map((filePath) => (
        <p key={filePath} className="break-words text-xs text-text-muted">
          {filePath}
        </p>
      ))}
      {content && (
        <pre className="max-h-40 max-w-full overflow-auto rounded-lg bg-code-bg px-3 py-2 text-xs leading-5 text-text-primary">
          {content.length > 500 ? content.substring(0, 500) + "..." : content}
        </pre>
      )}
    </div>
  );
}

function FileEditDetail({ block }: { block: ToolBlock }) {
  const filePaths = getFileInputPaths(block);
  const previews = getEditPreviews(block);
  return (
    <div className="min-w-0 space-y-1 overflow-x-hidden">
      {filePaths.map((filePath) => (
        <p key={filePath} className="break-words text-xs text-text-muted">
          {filePath}
        </p>
      ))}
      {previews.map((preview, index) => (
        <div
          key={`${index}:${preview.oldText ?? ""}:${preview.newText ?? ""}`}
          className="space-y-1"
        >
          {preview.oldText && (
            <pre className="max-h-24 max-w-full overflow-auto rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
              {truncate(preview.oldText, 300)}
            </pre>
          )}
          {preview.newText && (
            <pre className="max-h-24 max-w-full overflow-auto rounded-lg bg-green-50 px-3 py-2 text-xs leading-5 text-green-700">
              {truncate(preview.newText, 300)}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

function getEditPreviews(
  block: ToolBlock,
): Array<{ oldText?: string; newText?: string }> {
  const directOldText = getInputField(
    block,
    "old_string",
    "old_str",
    "oldString",
  );
  const directNewText = getInputField(
    block,
    "new_string",
    "new_str",
    "newString",
    "new_source",
  );
  if (directOldText || directNewText) {
    return [{ oldText: directOldText, newText: directNewText }];
  }

  const edits = block.toolInput?.edits;
  if (!Array.isArray(edits)) return [];

  return edits.flatMap((edit) => {
    if (!isRecord(edit)) return [];
    const oldText = getStringField(edit, "old_string", "old_str", "oldString");
    const newText = getStringField(edit, "new_string", "new_str", "newString");
    return oldText || newText ? [{ oldText, newText }] : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringField(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}
