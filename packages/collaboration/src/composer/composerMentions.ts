import { parsePluginMentionReference } from "@wegent/chat-core/plugin-reference";
import { encodeUriComponentStrict } from "@wegent/chat-core/uri-component";
import { COMPOSER_SKILL_ICON_PATHS } from "./composerSkillIconPaths";
import {
  fileReferenceIconPaths,
  PENCIL_SKILL_ICON_PATHS,
} from "./fileReferenceIcons";

import {
  classifyComposerReference,
  composerSkillName,
  parseComposerReference,
  parseComposerReferences,
} from "./composerReference";
export {
  classifyComposerReference,
  composerSkillName,
} from "./composerReference";

const composerMentionIcons = new Map<
  string,
  { url: string; contrastPad: boolean }
>();
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const COMPOSER_CONVERSATION_ICON_PATHS = [
  "M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z",
];

export interface ComposerMentionPayload {
  name: string;
  label: string;
  reference: string;
}

export interface ParsedComposerMention extends ComposerMentionPayload {
  start: number;
  end: number;
}

export type ComposerMentionIconRegistration = {
  url: string;
  contrastPad?: boolean;
};

export function registerComposerMentionIcon(
  reference: string,
  icon?: string | ComposerMentionIconRegistration | null,
): void {
  const href = parseComposerReference(reference)?.href;
  if (!href || !icon) return;
  const entry =
    typeof icon === "string"
      ? { url: icon.trim(), contrastPad: false }
      : { url: icon.url.trim(), contrastPad: Boolean(icon.contrastPad) };
  if (!entry.url) return;
  composerMentionIcons.set(href, entry);
}

export function getComposerMentionIconUrl(href: string): string | undefined {
  return composerMentionIcons.get(href)?.url;
}

function getComposerMentionIcon(
  href: string,
): { url: string; contrastPad: boolean } | undefined {
  return composerMentionIcons.get(href);
}

export type ComposerMentionIconResolver = (
  href: string,
) => { url: string; contrastPad: boolean } | null;

export function resolveComposerMentionBrandIcon(
  href: string,
  resolveIcon?: ComposerMentionIconResolver,
) {
  return getComposerMentionIcon(href) ?? resolveIcon?.(href) ?? null;
}

export function resolveComposerMentionBrandIconUrl(
  href: string,
  resolveIcon?: ComposerMentionIconResolver,
): string | null {
  return resolveComposerMentionBrandIcon(href, resolveIcon)?.url ?? null;
}

export function localSkillTestId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function displaySkillNameFromName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function parseComposerMentions(value: string): ParsedComposerMention[] {
  return parseComposerReferences(value).flatMap((link) => {
    const referenceKind = classifyComposerReference(link.label, link.href);
    const kind =
      referenceKind ?? (composerPathReference(link.reference) ? "file" : null);
    if (!kind) return [];
    const skill = composerSkillName(link.label);
    const name =
      kind === "skill"
        ? skill.name
        : referenceKind === null
          ? link.label
          : link.label.replace(/^[@$]/, "");
    const literalLabel = ["file", "folder", "cloud", "conversation"].includes(
      kind,
    );
    return [
      {
        name,
        label: literalLabel
          ? name
          : (skill.displayLabel ?? displaySkillNameFromName(name)),
        reference: link.reference,
        start: link.start,
        end: link.end,
      },
    ];
  });
}

export function composerSkillFilePath(reference: string): string | null {
  const link = parseComposerReference(reference);
  if (!link || classifyComposerReference(link.label, link.href) !== "skill")
    return null;
  return link.href.startsWith("skill://")
    ? link.href.slice("skill://".length)
    : link.href;
}

export function composerPathReference(reference: string): {
  path: string;
  directory: boolean;
} | null {
  const link = parseComposerReference(reference);
  if (!link?.href) return null;
  const href = link.href;
  const directory = href.startsWith("folder://");
  if (!directory && !href.startsWith("file://")) {
    // Ordinary Markdown path links become file mentions, independently of skill invocations.
    if (classifyComposerReference(link.label, href) !== null) return null;
    if (
      !/^[A-Za-z]:[\\/]/.test(href) &&
      /^(?:[A-Za-z][A-Za-z0-9+.-]*:|www\.|#)/.test(href)
    ) {
      return null;
    }
    return { path: href, directory: /[\\/]$/.test(href) };
  }
  const encodedPath = href.slice(
    directory ? "folder://".length : "file://".length,
  );
  try {
    return { path: decodeURIComponent(encodedPath), directory };
  } catch {
    return null;
  }
}

export function resolveComposerWorkspacePath(
  root: string,
  path: string,
): string {
  if (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(path)) return path;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${path.replace(/^[\\/]+/, "")}`;
}

export function createComposerPathReference(
  path: string,
  directory: boolean,
): string {
  const normalized = path.replaceAll("\\", "/");
  const name = normalized.split("/").filter(Boolean).at(-1) ?? normalized;
  const encodedPath = encodeUriComponentStrict(path);
  return `[$${name}](${directory ? "folder" : "file"}://${encodedPath})`;
}

export function replaceComposerMentionTrigger(
  value: string,
  reference: string,
  triggerStart: number,
  selectionEnd: number,
): { value: string; cursor: number } {
  const replacement = `${reference} `;
  return {
    value:
      value.slice(0, triggerStart) + replacement + value.slice(selectionEnd),
    cursor: triggerStart + replacement.length,
  };
}

export function findComposerMentionDeletionRange(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  key: "Backspace" | "Delete",
): { start: number; end: number; cursor: number } | null {
  const mentions = parseComposerMentions(value);
  if (selectionStart !== selectionEnd) {
    let start = selectionStart;
    let end = selectionEnd;
    let intersects = false;
    mentions.forEach((mention) => {
      if (mention.end <= start || mention.start >= end) return;
      intersects = true;
      start = Math.min(start, mention.start);
      end = Math.max(end, mention.end);
    });
    return intersects ? { start, end, cursor: start } : null;
  }

  const cursor = selectionStart;
  const mention = mentions.find((item) =>
    key === "Backspace"
      ? cursor > item.start && cursor <= item.end
      : cursor >= item.start && cursor < item.end,
  );
  if (!mention) return null;

  return { start: mention.start, end: mention.end, cursor: mention.start };
}

export function createComposerMentionElement(
  payload: ComposerMentionPayload,
  resolveIcon?: ComposerMentionIconResolver,
): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = "composer-mention-node composer-mention-link";
  const pathReference = composerPathReference(payload.reference);
  const pluginReference = parsePluginMentionReference(payload.reference);
  const conversationReference = payload.reference.includes(
    "](wework-conversation://",
  );
  const displayLabel = payload.label;
  element.setAttribute(
    "data-testid",
    pathReference
      ? `composer-path-chip-${localSkillTestId(payload.name)}`
      : pluginReference
        ? `composer-plugin-chip-${localSkillTestId(pluginReference.pluginName)}`
        : conversationReference
          ? `conversation-chip-${localSkillTestId(payload.name)}`
          : `local-skill-chip-${localSkillTestId(payload.name)}`,
  );
  element.setAttribute("data-composer-skill-reference", payload.reference);
  element.setAttribute("data-composer-skill-name", payload.name);
  element.setAttribute("data-composer-skill-label", displayLabel);
  const skillFilePath = composerSkillFilePath(payload.reference);
  if (skillFilePath)
    element.setAttribute("data-composer-skill-path", skillFilePath);
  if (pathReference) {
    element.setAttribute("data-composer-path", pathReference.path);
    element.setAttribute(
      "data-composer-path-kind",
      pathReference.directory ? "folder" : "file",
    );
  }
  if (pluginReference) {
    element.setAttribute(
      "data-composer-plugin-name",
      pluginReference.pluginName,
    );
    element.setAttribute(
      "data-composer-plugin-marketplace",
      pluginReference.marketplaceName,
    );
    element.setAttribute("role", "link");
  }
  element.setAttribute("contenteditable", "false");
  element.setAttribute("aria-label", displayLabel);
  element.setAttribute("spellcheck", "false");
  element.setAttribute("tabindex", pluginReference ? "0" : "-1");

  const iconSlot = document.createElement("span");
  iconSlot.className = "composer-mention-icon-slot";
  iconSlot.setAttribute("aria-hidden", "true");
  const mentionHref = parseComposerReference(payload.reference)?.href;
  const brandIcon = mentionHref
    ? resolveComposerMentionBrandIcon(mentionHref, resolveIcon)
    : null;
  if (brandIcon?.contrastPad) {
    iconSlot.classList.add("composer-mention-icon-slot--contrast-pad");
  }
  iconSlot.append(
    pathReference?.directory
      ? createComposerFolderIcon()
      : conversationReference
        ? createComposerConversationIcon()
        : brandIcon
          ? createComposerBrandIcon(brandIcon.url)
          : createComposerMentionIcon(
              pathReference
                ? fileReferenceIconPaths(pathReference.path)
                : composerSkillName(
                      parseComposerReference(payload.reference)?.label ?? "",
                    ).icon === "pencil-sparkle"
                  ? PENCIL_SKILL_ICON_PATHS
                  : COMPOSER_SKILL_ICON_PATHS,
            ),
  );

  const label = document.createElement("span");
  label.className = "composer-mention-label";
  label.textContent = displayLabel;

  element.append(iconSlot, label);
  return element;
}

function createComposerBrandIcon(iconUrl: string): HTMLImageElement {
  const icon = document.createElement("img");
  icon.className = "composer-mention-icon composer-mention-brand-icon";
  icon.src = iconUrl;
  icon.alt = "";
  return icon;
}

function createComposerFolderIcon(): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, "svg");
  icon.classList.add("composer-mention-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute(
    "d",
    "M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  );
  icon.append(path);
  return icon;
}

function createComposerMentionIcon(paths: readonly string[]): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, "svg");
  icon.classList.add("composer-mention-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  paths.forEach((pathData) => {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", pathData);
    icon.append(path);
  });
  return icon;
}

function createComposerConversationIcon(): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, "svg");
  icon.classList.add("composer-mention-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  COMPOSER_CONVERSATION_ICON_PATHS.forEach((pathData) => {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", pathData);
    icon.append(path);
  });
  return icon;
}
