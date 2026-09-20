import { FileReferenceIcon } from '../composer/FileReferenceIcon';
import {
  Fragment,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { HTMLAttributes, OlHTMLAttributes, ReactNode } from "react";
import { Folder, Link2 } from "lucide-react";
import { Streamdown } from "streamdown";
import { ComposerLinkChip } from "./ComposerLinkChip";
import { unescapeMarkdownReference } from '../composer/composerReference'
import "streamdown/styles.css";
import {
  classifyMarkdownLink,
  decodeMarkdownFilePath,
  isHtmlFilePath,
  localMarkdownImagePath,
  type MarkdownLinkTarget,
} from "./assistantMarkdownLinks";
import { AssistantMarkdownImage } from "./AssistantMarkdownImage";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { MarkdownTable } from "./MarkdownTable";
import { createTableMarkdownRehypePlugins } from "./markdownTableSource";
import { MarkdownDiagramPreview } from "./MarkdownDiagramPreview";
import { splitStaticMarkdownChunks } from "./assistantMarkdownWindowing";
import { useBufferedStreamingText } from "./useBufferedStreamingText";
import { splitCodexInlineVisualizations } from "./codex-directives";
import { getRecognizedLink } from "./link-preview";
import { Tooltip } from "../issue-detail/Tooltip";
import {
  useMarkdownServices,
  type MarkdownFileOpenOptions,
} from "./MarkdownServices";

const ASSISTANT_MARKDOWN_LINK_CLASS = [
  "inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-0.5 align-baseline",
  "text-sm font-medium leading-5 text-blue-600 no-underline",
  "transition-colors hover:text-blue-700",
  "dark:text-blue-300 dark:hover:text-blue-200",
  "[&_code]:!rounded-none [&_code]:!bg-transparent [&_code]:!px-0 [&_code]:!py-0 [&_code]:!font-[inherit] [&_code]:!text-inherit",
].join(" ");
const CODEX_PLAN_TAG_PATTERN = /<\/?\s*proposed_plan\s*>/gi;
const CONTENT_REFERENCE_CITATION_PATTERN = /\uE200cite\uE202[\s\S]*?\uE201/g;
const TRAILING_CONTENT_REFERENCE_CITATION_PATTERN =
  /\uE200cite(?:\uE202[\s\S]*)?$/;
const WEWORK_MARKDOWN_FILE_LINK_HOST = "wework.local";
const WEWORK_MARKDOWN_FILE_LINK_PATH = "/markdown-file";
const WEWORK_MARKDOWN_FILE_LINK_PREFIX = `https://${WEWORK_MARKDOWN_FILE_LINK_HOST}${WEWORK_MARKDOWN_FILE_LINK_PATH}?path=`;
const WEWORK_MARKDOWN_IMAGE_PATH = "/markdown-image";
const WEWORK_MARKDOWN_IMAGE_PREFIX = `https://${WEWORK_MARKDOWN_FILE_LINK_HOST}${WEWORK_MARKDOWN_IMAGE_PATH}?path=`;
const MARKDOWN_LINK_PATTERN = /(!?)\[((?:\\[^\r\n]|[^\]\\\r\n])+)\]\(((?:\\[^\r\n]|[^)\\\r\n])+)\)/g;
const tableMarkdownRehypePlugins = createTableMarkdownRehypePlugins(
  restoreLocalMarkdownLinks,
);
const MARKDOWN_WINDOW_ROOT_MARGIN = "1600px 0px";
const DIAGRAM_LANGUAGES = new Set(["mermaid", "mmd", "plantuml", "puml"]);
const STREAMING_DIAGRAM_LANGUAGES = new Map([
  ["weworkstreamingmermaid", "mermaid"],
  ["weworkstreamingmmd", "mmd"],
  ["weworkstreamingplantuml", "plantuml"],
  ["weworkstreamingpuml", "puml"],
]);
const MarkdownStreamingContext = createContext(false);
export interface AssistantMarkdownProps {
  content: string;
  isStreaming?: boolean;
  variant?: "default" | "document" | "process" | "user";
  renderLink?: (href: string, text: string) => ReactNode;
  onOpenFile?: (path: string, options?: MarkdownFileOpenOptions) => void;
  renderVisualization?: (part: {
    file: string;
    mode?: "wide";
    title?: string;
  }) => ReactNode;
}

const MarkdownCustomLinkContext =
  createContext<AssistantMarkdownProps["renderLink"]>(undefined);

const MARKDOWN_HEADING_CLASSES = {
  default: {
    h1: "mb-4 mt-6 text-lg font-semibold text-text-primary",
    h2: "mb-3 mt-5 text-base font-semibold text-text-primary",
    h3: "mb-2 mt-4 text-sm font-semibold text-text-primary",
  },
  document: {
    h1: "mb-5 mt-8 text-heading-lg font-semibold tracking-[-0.02em] text-text-primary",
    h2: "mb-4 mt-7 text-heading-md font-semibold tracking-[-0.01em] text-text-primary",
    h3: "mb-3 mt-6 text-heading-sm font-semibold text-text-primary",
  },
  process: {
    h1: "mb-2 mt-3 text-base font-semibold text-text-primary",
    h2: "mb-1.5 mt-3 text-sm font-semibold text-text-primary",
    h3: "mb-1 mt-2 text-sm font-semibold text-text-primary",
  },
} as const;

const DOCUMENT_MARKDOWN_HEADING_COMPONENTS = {
  h4: ({ children }: { children?: ReactNode }) => (
    <h4
      data-scroll-anchor
      className="mb-2 mt-5 text-lg font-semibold text-text-primary"
    >
      {children}
    </h4>
  ),
  h5: ({ children }: { children?: ReactNode }) => (
    <h5
      data-scroll-anchor
      className="mb-2 mt-4 text-base font-semibold text-text-primary"
    >
      {children}
    </h5>
  ),
  h6: ({ children }: { children?: ReactNode }) => (
    <h6
      data-scroll-anchor
      className="mb-2 mt-4 text-sm font-semibold text-text-secondary"
    >
      {children}
    </h6>
  ),
};

type AssistantMarkdownPart =
  | { kind: "markdown"; content: string; windowed: boolean }
  | { kind: "visualization"; file: string; mode?: "wide"; title?: string };

export const AssistantMarkdown = memo(function AssistantMarkdown({
  content,
  isStreaming = false,
  variant = "default",
  onOpenFile,
  renderVisualization: renderVisualizationOverride,
  renderLink,
}: AssistantMarkdownProps) {
  const services = useMarkdownServices();
  const renderVisualization =
    renderVisualizationOverride ?? services.renderVisualization;
  const bufferedContent = useBufferedStreamingText(content, isStreaming);
  const streamdownMode =
    variant === "default" || isStreaming
      ? ("streaming" as const)
      : ("static" as const);
  const displayContent = useMemo(
    () =>
      variant === "user"
        ? bufferedContent
        : stripUnsupportedContentReferenceCitations(bufferedContent),
    [bufferedContent, variant],
  );
  const windowMarkdown =
    Boolean(services.windowMarkdown) && variant === "default";
  const contentParts = useMemo(() => {
    const parts =
      variant === "user" || !renderVisualization
        ? [{ kind: "markdown" as const, content: displayContent }]
        : splitCodexInlineVisualizations(displayContent);
    return parts.flatMap<AssistantMarkdownPart>((part) => {
      if (part.kind === "visualization") return [part];
      const chunks = windowMarkdown
        ? splitStaticMarkdownChunks(part.content)
        : [part.content];
      const windowed = windowMarkdown;
      return chunks.map((content) => ({ kind: "markdown", content, windowed }));
    });
  }, [displayContent, windowMarkdown, variant, renderVisualization]);
  const openFileRef = useRef(onOpenFile);

  useEffect(() => {
    openFileRef.current = onOpenFile;
  }, [onOpenFile]);

  const openFile = useCallback(
    (path: string, options?: MarkdownFileOpenOptions) => {
      if (options) {
        openFileRef.current?.(path, options);
        return;
      }
      openFileRef.current?.(path);
    },
    [],
  );
  const headingClasses =
    MARKDOWN_HEADING_CLASSES[variant === "user" ? "default" : variant];
  const canOpenFile = Boolean(onOpenFile);
  const components = useMemo(
    () => ({
      h1: ({ children }: { children?: ReactNode }) => (
        <h1 data-scroll-anchor className={headingClasses.h1}>
          {children}
        </h1>
      ),
      h2: ({ children }: { children?: ReactNode }) => (
        <h2 data-scroll-anchor className={headingClasses.h2}>
          {children}
        </h2>
      ),
      h3: ({ children }: { children?: ReactNode }) => (
        <h3 data-scroll-anchor className={headingClasses.h3}>
          {children}
        </h3>
      ),
      ...(variant === "document" ? DOCUMENT_MARKDOWN_HEADING_COMPONENTS : {}),
      p: ({ children }: { children?: ReactNode }) => (
        <p
          data-scroll-anchor
          className={`${variant === "process" ? "mb-1.5" : variant === "user" ? "mb-2 whitespace-pre-wrap" : "mb-3"} min-w-0 break-words leading-6`}
        >
          {children}
        </p>
      ),
      ul: ({ children }: { children?: ReactNode }) => (
        <ul
          className={`${variant === "process" ? "mb-1.5 space-y-0.5" : "mb-3 space-y-1.5"} list-disc pl-5`}
        >
          {children}
        </ul>
      ),
      ol: ({ children, start }: OlHTMLAttributes<HTMLOListElement>) => (
        <ol
          start={start}
          className={`${variant === "process" ? "mb-1.5 space-y-0.5 pl-5" : "mb-3 space-y-1.5 pl-8"} list-decimal`}
        >
          {children}
        </ol>
      ),
      li: ({ children }: { children?: ReactNode }) => (
        <li
          data-scroll-anchor
          className={`min-w-0 break-words leading-6 ${variant === "process" ? "" : "pl-1"}`}
        >
          {children}
        </li>
      ),
      strong: ({ children }: { children?: ReactNode }) => (
        <strong className="font-semibold">{children}</strong>
      ),
      code: (props: MarkdownCodeProps) => (
        <MarkdownCode {...props} compact={variant === "process"} />
      ),
      inlineCode: ({ children }: { children?: ReactNode }) => (
        <MarkdownInlineCode compact={variant === "process"}>
          {children}
        </MarkdownInlineCode>
      ),
      blockquote: ({ children }: { children?: ReactNode }) => (
        <blockquote
          data-scroll-anchor
          className={`${variant === "process" ? "mb-1.5 pl-3 opacity-80" : "mb-3 pl-4"} border-l-3 border-border text-text-secondary`}
        >
          {children}
        </blockquote>
      ),
      table: MarkdownTable,
      th: ({ children, style }: HTMLAttributes<HTMLTableCellElement>) => (
        <th
          style={style}
          className="border-b border-border px-3 py-2 text-left font-semibold"
        >
          {children}
        </th>
      ),
      td: ({ children, style }: HTMLAttributes<HTMLTableCellElement>) => (
        <td style={style} className="border-b border-border px-3 py-2">
          {children}
        </td>
      ),
      a: function MarkdownAnchor({
        href: rawHref,
        children,
      }: {
        href?: string;
        children?: ReactNode;
      }) {
        const renderLink = useContext(MarkdownCustomLinkContext);
        const href = decodeLocalMarkdownHref(rawHref);
        const text = reactNodeToText(children);
        const customLink = href ? renderLink?.(href, text) : undefined;
        if (customLink !== undefined) return customLink;
        const isComposerLink =
          href &&
          /^[a-z][a-z0-9+.-]*:\/\//i.test(href) &&
          text &&
          text !== href &&
          getRecognizedLink(href);
        if (
          isComposerLink &&
          !href?.startsWith(WEWORK_MARKDOWN_FILE_LINK_PREFIX)
        ) {
          return <ComposerLinkChip payload={{ url: href, label: text }} />;
        }
        return (
          <AssistantMarkdownLink
            href={href}
            onOpenFile={canOpenFile ? openFile : undefined}
          >
            {children}
          </AssistantMarkdownLink>
        );
      },
      img: ({ src, alt }: { src?: string | Blob; alt?: string }) => (
        <AssistantMarkdownImage
          src={
            typeof src === "string"
              ? decodeLocalMarkdownImageSrc(src.trim())
              : undefined
          }
          alt={alt}
        />
      ),
    }),
    [headingClasses, openFile, variant, canOpenFile],
  );

  return (
    <MarkdownCustomLinkContext.Provider value={renderLink}>
      <div
        className={`${variant === "user" ? "user-markdown" : variant === "process" ? "thinking-markdown" : "assistant-markdown"} min-w-0 max-w-full break-words`}
      >
        {contentParts.map((part, index) =>
          part.kind === "visualization" ? (
            <Fragment key={`${part.file}-${index}`}>
              {renderVisualization?.(part)}
            </Fragment>
          ) : part.windowed ? (
            <WindowedMarkdownChunk
              key={`markdown-${index}`}
              content={part.content}
              eager={index === 0 || index === contentParts.length - 1}
            >
              <MarkdownStreamingContext.Provider
                value={isStreaming && index === contentParts.length - 1}
              >
                <Streamdown
                  mode={streamdownMode}
                  isAnimating={false}
                  controls={false}
                  linkSafety={{ enabled: false }}
                  lineNumbers={false}
                  urlTransform={(url: string) => url}
                  components={components}
                  rehypePlugins={tableMarkdownRehypePlugins}
                >
                  {prepareAssistantMarkdownContent(
                    part.content,
                    isStreaming && index === contentParts.length - 1,
                  )}
                </Streamdown>
              </MarkdownStreamingContext.Provider>
            </WindowedMarkdownChunk>
          ) : (
            <MarkdownStreamingContext.Provider
              key={`markdown-${index}`}
              value={isStreaming}
            >
              <Streamdown
                mode={streamdownMode}
                isAnimating={false}
                controls={false}
                linkSafety={{ enabled: false }}
                lineNumbers={false}
                urlTransform={(url: string) => url}
                components={components}
                rehypePlugins={tableMarkdownRehypePlugins}
              >
                {variant === "user"
                  ? encodeLocalMarkdownLinks(part.content)
                  : prepareAssistantMarkdownContent(part.content, isStreaming)}
              </Streamdown>
            </MarkdownStreamingContext.Provider>
          ),
        )}
      </div>
    </MarkdownCustomLinkContext.Provider>
  );
}, areAssistantMarkdownPropsEqual);

function WindowedMarkdownChunk({
  content,
  eager,
  children,
}: {
  content: string;
  eager: boolean;
  children: ReactNode;
}) {
  const chunkRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(
    () => typeof IntersectionObserver === "undefined" || eager,
  );
  const [retainedHeight, setRetainedHeight] = useState<number | null>(null);

  useEffect(() => {
    if (eager || typeof IntersectionObserver === "undefined") return;
    const chunk = chunkRef.current;
    if (!chunk) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (!entry.isIntersecting) {
          const height = chunk.getBoundingClientRect().height;
          if (height > 0) setRetainedHeight(height);
        }
        setNearViewport(entry.isIntersecting);
      },
      { rootMargin: MARKDOWN_WINDOW_ROOT_MARGIN },
    );
    observer.observe(chunk);
    return () => observer.disconnect();
  }, [eager]);

  const reservedHeight = retainedHeight ?? estimateMarkdownChunkHeight(content);

  return (
    <div
      ref={chunkRef}
      data-markdown-window-chunk
      style={nearViewport ? undefined : { minHeight: reservedHeight }}
    >
      {nearViewport ? (
        children
      ) : (
        <div
          data-markdown-window-placeholder
          className="overflow-hidden whitespace-pre-wrap leading-6"
          style={{ maxHeight: reservedHeight }}
        >
          {content}
        </div>
      )}
    </div>
  );
}

function estimateMarkdownChunkHeight(content: string): number {
  const lineCount = content.split("\n").length;
  return Math.max(120, Math.min(1_200, lineCount * 24));
}

type MarkdownCodeProps = {
  node?: {
    properties?: unknown;
  };
  compact?: boolean;
} & HTMLAttributes<HTMLElement>;

function MarkdownCode({
  className,
  children,
  node,
  compact = false,
  ...props
}: MarkdownCodeProps) {
  const isStreaming = useContext(MarkdownStreamingContext);
  const match = /language-(\w*)/.exec(className || "");
  const text = reactNodeToText(children);
  const nodeDataBlock =
    typeof node?.properties === "object" &&
    node.properties !== null &&
    "dataBlock" in node.properties &&
    node.properties.dataBlock === "true";
  const isBlock =
    ("data-block" in props && Boolean(props["data-block"])) ||
    nodeDataBlock ||
    Boolean(match) ||
    text.includes("\n");
  if (isBlock) {
    const lang = match ? match[1] || "" : "";
    const streamingDiagramLanguage = STREAMING_DIAGRAM_LANGUAGES.get(
      lang.toLowerCase(),
    );
    if (streamingDiagramLanguage) {
      return (
        <MarkdownCodeBlock
          lang={streamingDiagramLanguage}
          compact={compact}
          isStreaming
        >
          {text || children}
        </MarkdownCodeBlock>
      );
    }
    if (DIAGRAM_LANGUAGES.has(lang.toLowerCase())) {
      return <MarkdownDiagramPreview code={text.trimEnd()} language={lang} />;
    }
    return (
      <MarkdownCodeBlock
        lang={lang}
        compact={compact}
        isStreaming={isStreaming}
      >
        {text || children}
      </MarkdownCodeBlock>
    );
  }
  return <MarkdownInlineCode compact={compact}>{children}</MarkdownInlineCode>;
}

function MarkdownInlineCode({
  children,
  compact = false,
}: {
  children?: ReactNode;
  compact?: boolean;
}) {
  return (
    <code
      className={`break-words rounded bg-muted px-1.5 py-0.5 font-medium text-text-primary ${compact ? "text-xs" : "text-code"}`}
    >
      {children}
    </code>
  );
}

function areAssistantMarkdownPropsEqual(
  previous: AssistantMarkdownProps,
  next: AssistantMarkdownProps,
): boolean {
  return (
    previous.content === next.content &&
    previous.isStreaming === next.isStreaming &&
    previous.renderVisualization === next.renderVisualization &&
    previous.variant === next.variant &&
    previous.onOpenFile === next.onOpenFile &&
    previous.renderLink === next.renderLink
  );
}

function prepareAssistantMarkdownContent(
  content: string,
  isStreaming = false,
): string {
  const normalizedContent = content.replace(CODEX_PLAN_TAG_PATTERN, "");
  return encodeLocalMarkdownLinks(
    isStreaming
      ? markUnclosedDiagramFence(normalizedContent)
      : normalizedContent,
  );
}

function markUnclosedDiagramFence(content: string): string {
  const lines = content.split("\n");
  let openingFence: {
    character: "`" | "~";
    length: number;
    language: string;
    lineIndex: number;
    match: RegExpExecArray;
  } | null = null;

  for (const [lineIndex, line] of lines.entries()) {
    if (!openingFence) {
      const match = /^( {0,3})(`{3,}|~{3,})([ \t]*)([\w+-]*)([^\n]*)$/.exec(
        line,
      );
      if (!match) continue;

      const fence = match[2];
      const language = match[4].toLowerCase();
      openingFence = {
        character: fence[0] as "`" | "~",
        length: fence.length,
        language,
        lineIndex,
        match,
      };
      continue;
    }

    const closingFence = new RegExp(
      `^ {0,3}${openingFence.character}{${openingFence.length},}[ \\t]*$`,
    );
    if (closingFence.test(line)) {
      openingFence = null;
    }
  }

  if (!openingFence || !DIAGRAM_LANGUAGES.has(openingFence.language))
    return content;

  const [, indent, fence, spacing, , remainder] = openingFence.match;
  lines[openingFence.lineIndex] =
    `${indent}${fence}${spacing}` +
    `weworkstreaming${openingFence.language}${remainder}`;
  return lines.join("\n");
}

function stripUnsupportedContentReferenceCitations(content: string): string {
  return content
    .replace(CONTENT_REFERENCE_CITATION_PATTERN, "")
    .replace(TRAILING_CONTENT_REFERENCE_CITATION_PATTERN, "");
}

function splitMarkdownImageDestination(rawHref: string): {
  destination: string;
  titleSuffix: string;
} {
  const href = rawHref.trim();
  if (href.startsWith("<")) {
    const closingBracket = href.indexOf(">");
    if (closingBracket > 0) {
      return {
        destination: href.slice(1, closingBracket),
        titleSuffix: href.slice(closingBracket + 1),
      };
    }
  }

  const titledDestination = href.match(/^(.*?)(\s+(?:"[^"]*"|'[^']*'))$/);
  return titledDestination
    ? {
        destination: titledDestination[1].trim(),
        titleSuffix: titledDestination[2],
      }
    : { destination: href, titleSuffix: "" };
}

function encodeLocalMarkdownLinks(content: string): string {
  return content.replace(
    MARKDOWN_LINK_PATTERN,
    (match, imageMarker, label, rawHref) => {
      const href = unescapeMarkdownReference(String(rawHref).trim())
      if (imageMarker) {
        const { destination, titleSuffix } =
          splitMarkdownImageDestination(href);
        const localPath = localMarkdownImagePath(destination);
        return localPath
          ? `![${label}](${WEWORK_MARKDOWN_IMAGE_PREFIX}${encodeURIComponent(localPath)}${titleSuffix})`
          : match;
      }
      const target = classifyMarkdownLink(href);
      const internal =
        /^(?:skill|plugin|app|cloud|wework-conversation|wegent-sites-project|wegent|folder|file):\/\//.test(
          href,
        );
      if (target.kind !== "file" && !internal) return match;
      return `[${label}](${WEWORK_MARKDOWN_FILE_LINK_PREFIX}${encodeURIComponent(
        internal ? href : decodeMarkdownFilePath(href),
      )})`;
    },
  );
}

function restoreLocalMarkdownLinks(content: string): string {
  return content.replace(
    MARKDOWN_LINK_PATTERN,
    (match, imageMarker, label, rawHref) => {
      const { destination, titleSuffix } = splitMarkdownImageDestination(
        String(rawHref),
      );
      const decoded = imageMarker
        ? decodeLocalMarkdownImageSrc(destination)
        : decodeLocalMarkdownHref(destination);
      if (!decoded || decoded === destination) return match;
      const href = /\s/.test(decoded) ? `<${decoded}>` : decoded;
      return `${imageMarker}[${label}](${href}${titleSuffix})`;
    },
  );
}

function decodeLocalMarkdownImageSrc(src: string): string {
  try {
    const url = new URL(src);
    if (
      url.protocol === "https:" &&
      url.hostname === WEWORK_MARKDOWN_FILE_LINK_HOST &&
      url.pathname === WEWORK_MARKDOWN_IMAGE_PATH
    ) {
      return url.searchParams.get("path") ?? src;
    }
  } catch {
    return src;
  }
  return src;
}

function decodeLocalMarkdownHref(href?: string): string | undefined {
  if (!href) return href;
  try {
    const url = new URL(href);
    if (
      url.protocol === "https:" &&
      url.hostname === WEWORK_MARKDOWN_FILE_LINK_HOST &&
      url.pathname === WEWORK_MARKDOWN_FILE_LINK_PATH
    ) {
      return url.searchParams.get("path") ?? href;
    }
  } catch {
    return href;
  }
  return href;
}

function reactNodeToText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeToText).join("");
  return "";
}

function formatMarkdownLineLabel(
  target: Extract<MarkdownLinkTarget, { kind: "file" }>,
): string {
  if (typeof target.lineStart !== "number") return "";
  if (
    typeof target.lineEnd === "number" &&
    target.lineEnd !== target.lineStart
  ) {
    return `lines ${target.lineStart}-${target.lineEnd}`;
  }
  return `line ${target.lineStart}`;
}

function formatMarkdownFileTooltip(
  target: Extract<MarkdownLinkTarget, { kind: "file" }>,
): string {
  const lineLabel = formatMarkdownLineLabel(target);
  return lineLabel ? `${target.path} (${lineLabel})` : target.path;
}

function getMarkdownFileOpenOptions(
  target: Extract<MarkdownLinkTarget, { kind: "file" }>,
): MarkdownFileOpenOptions | undefined {
  if (typeof target.lineStart !== "number" && !target.isDirectory)
    return undefined;
  return {
    lineStart: target.lineStart,
    lineEnd: target.lineEnd,
    isDirectory: target.isDirectory,
  };
}

function getMarkdownFileIcon(path: string): ReactNode {
  return <FileReferenceIcon path={path} className="h-3.5 w-3.5 shrink-0" data-testid="assistant-markdown-link-icon" />;
}

function AssistantMarkdownLink({
  href,
  onOpenFile,
  children,
}: {
  href?: string;
  onOpenFile?: (path: string, options?: MarkdownFileOpenOptions) => void;
  children?: ReactNode;
}) {
  const { openExternalUrl, navigateTo, openHtmlFile } = useMarkdownServices();
  const target = classifyMarkdownLink(decodeLocalMarkdownHref(href));
  const icon =
    target.kind === "file" ? (
      target.isDirectory ? (
        <Folder
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0"
          data-testid="assistant-markdown-link-icon"
        />
      ) : (
        getMarkdownFileIcon(target.path)
      )
    ) : (
      <Link2
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0"
        data-testid="assistant-markdown-link-icon"
      />
    );

  if (target.kind === "file") {
    const filePath = target.path;
    const canOpenWithoutWorkspace =
      isHtmlFilePath(filePath) && Boolean(openHtmlFile);
    const lineLabel = formatMarkdownLineLabel(target);
    const tooltip = formatMarkdownFileTooltip(target);
    const openOptions = getMarkdownFileOpenOptions(target);
    return (
      <Tooltip
        label={tooltip}
        align="start"
        testId="assistant-markdown-link-tooltip"
        className="min-w-0 max-w-full !shrink align-baseline"
      >
        <button
          type="button"
          className={ASSISTANT_MARKDOWN_LINK_CLASS}
          data-testid="assistant-markdown-link"
          disabled={!onOpenFile && !canOpenWithoutWorkspace}
          onClick={() => {
            if (isHtmlFilePath(filePath)) {
              if (openHtmlFile?.(filePath)) return;
            }
            if (openOptions) {
              onOpenFile?.(filePath, openOptions);
              return;
            }
            onOpenFile?.(filePath);
          }}
          aria-label={tooltip}
        >
          {icon}
          <span
            className="min-w-0 whitespace-normal [overflow-wrap:anywhere]"
            data-testid="assistant-markdown-link-label"
          >
            {children}
          </span>
          {lineLabel ? (
            <span
              className="shrink-0"
              data-testid="assistant-markdown-link-line"
            >
              ({lineLabel})
            </span>
          ) : null}
        </button>
      </Tooltip>
    );
  }

  if (target.kind === "internal") {
    return (
      <button
        type="button"
        className={ASSISTANT_MARKDOWN_LINK_CLASS}
        data-testid="assistant-markdown-link"
        disabled={!navigateTo}
        onClick={() => navigateTo?.(target.path)}
      >
        {icon}
        <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">
          {children}
        </span>
      </button>
    );
  }

  return (
    <a
      href={href}
      className={ASSISTANT_MARKDOWN_LINK_CLASS}
      data-testid="assistant-markdown-link"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!href) return;
        void Promise.resolve(openExternalUrl(href)).catch((error) => {
          console.error("[Wework] Failed to open assistant link", error);
        });
      }}
    >
      {icon}
      <span
        className="min-w-0 whitespace-normal [overflow-wrap:anywhere]"
        data-testid="assistant-markdown-link-label"
      >
        {children}
      </span>
    </a>
  );
}
