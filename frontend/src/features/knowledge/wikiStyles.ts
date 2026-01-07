// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiki content styles - Modern design inspired by deepwiki.com
 * Features:
 * - Clean, minimal aesthetic
 * - Enhanced code blocks with syntax highlighting
 * - Beautiful Mermaid diagram containers
 * - Responsive typography
 * - Dark/Light theme support
 */
export const wikiStyles = `
  :root {
    /* Code block colors - Dark theme (Tokyo Night inspired) */
    --code-bg: #1a1b26;
    --code-bg-secondary: #16161e;
    --code-text: #a9b1d6;
    --code-border: #414868;
    --code-line-number: #565f89;
    --code-selection: rgba(65, 72, 104, 0.4);

    /* Syntax highlighting - Dark theme */
    --syntax-keyword: #9d7cd8;
    --syntax-function: #7aa2f7;
    --syntax-string: #9ece6a;
    --syntax-number: #ff9e64;
    --syntax-comment: #565f89;
    --syntax-class: #2ac3de;
    --syntax-operator: #89ddff;
    --syntax-punctuation: #a9b1d6;
    --syntax-property: #73daca;
    --syntax-variable: #c0caf5;
    --syntax-constant: #ff757f;
    --syntax-type: #2ac3de;

    /* Mermaid diagram colors */
    --mermaid-bg: #ffffff;
    --mermaid-border: #e2e8f0;
    --mermaid-node-bg: #f8fafc;
    --mermaid-node-border: #94a3b8;
    --mermaid-text: #334155;
    --mermaid-line: #64748b;
    --mermaid-primary: var(--color-primary, #14b8a6);
  }

  :root.light {
    /* Code block colors - Light theme */
    --code-bg: #fafafa;
    --code-bg-secondary: #f5f5f5;
    --code-text: #383a42;
    --code-border: #e5e5e5;
    --code-line-number: #9ca3af;
    --code-selection: rgba(0, 0, 0, 0.07);

    /* Syntax highlighting - Light theme (One Light inspired) */
    --syntax-keyword: #a626a4;
    --syntax-function: #4078f2;
    --syntax-string: #50a14f;
    --syntax-number: #986801;
    --syntax-comment: #a0a1a7;
    --syntax-class: #c18401;
    --syntax-operator: #0184bc;
    --syntax-punctuation: #383a42;
    --syntax-property: #e45649;
    --syntax-variable: #383a42;
    --syntax-constant: #b31d28;
    --syntax-type: #c18401;

    /* Mermaid diagram colors - Light */
    --mermaid-bg: #ffffff;
    --mermaid-border: #e2e8f0;
    --mermaid-node-bg: #f1f5f9;
    --mermaid-node-border: #cbd5e1;
    --mermaid-text: #1e293b;
    --mermaid-line: #475569;
  }

  .dark {
    --mermaid-bg: #1e293b;
    --mermaid-border: #334155;
    --mermaid-node-bg: #334155;
    --mermaid-node-border: #475569;
    --mermaid-text: #e2e8f0;
    --mermaid-line: #94a3b8;
  }

  /* Wiki content container */
  .wiki-content {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
    line-height: 1.75;
    color: var(--text-primary);
    font-size: 16px;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* Headings with modern styling */
  .wiki-content h1,
  .wiki-content h2,
  .wiki-content h3,
  .wiki-content h4,
  .wiki-content h5,
  .wiki-content h6 {
    font-weight: 700;
    line-height: 1.3;
    letter-spacing: -0.02em;
    color: var(--text-primary);
  }

  .wiki-content h1 {
    font-size: 2em;
    margin-top: 2em;
    margin-bottom: 0.75em;
    padding-bottom: 0.5em;
    border-bottom: 2px solid var(--border);
  }

  .wiki-content h2 {
    font-size: 1.5em;
    margin-top: 1.75em;
    margin-bottom: 0.5em;
    padding-bottom: 0.25em;
    border-bottom: 1px solid var(--border);
  }

  .wiki-content h3 {
    font-size: 1.25em;
    margin-top: 1.5em;
    margin-bottom: 0.5em;
  }

  .wiki-content h4 {
    font-size: 1.1em;
    margin-top: 1.25em;
    margin-bottom: 0.5em;
  }

  /* Paragraphs */
  .wiki-content p {
    margin-top: 0;
    margin-bottom: 1.25em;
    line-height: 1.8;
    color: var(--text-primary);
  }

  /* Lists with custom bullets */
  .wiki-content ul,
  .wiki-content ol {
    margin-top: 0;
    margin-bottom: 1.25em;
    padding-left: 1.5em;
  }

  .wiki-content ul {
    list-style-type: none;
  }

  .wiki-content ul > li {
    position: relative;
    padding-left: 1em;
  }

  .wiki-content ul > li::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.6em;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background-color: var(--color-primary, #14b8a6);
    opacity: 0.7;
  }

  .wiki-content ol {
    list-style-type: decimal;
    counter-reset: list-counter;
  }

  .wiki-content ol > li {
    counter-increment: list-counter;
  }

  .wiki-content li {
    margin-bottom: 0.5em;
    color: var(--text-primary);
    line-height: 1.7;
  }

  .wiki-content li > ul,
  .wiki-content li > ol {
    margin-top: 0.5em;
    margin-bottom: 0.5em;
  }

  /* Tables with modern styling */
  .wiki-content table {
    border-collapse: separate;
    border-spacing: 0;
    width: 100%;
    margin: 1.5em 0;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.06);
    border: 1px solid var(--border);
  }

  .wiki-content table th,
  .wiki-content table td {
    padding: 0.75em 1em;
    text-align: left;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
  }

  .wiki-content table th {
    background: linear-gradient(to bottom, var(--surface), var(--surface-hover));
    font-weight: 600;
    font-size: 0.875em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }

  .wiki-content table tr:last-child td {
    border-bottom: none;
  }

  .wiki-content table tr:hover td {
    background-color: var(--surface-hover);
  }

  /* Blockquotes - callout style */
  .wiki-content blockquote {
    margin: 1.5em 0;
    padding: 1em 1.5em;
    background: linear-gradient(135deg, rgba(var(--color-primary-rgb, 20, 184, 166), 0.08), transparent);
    border-left: 4px solid var(--color-primary, #14b8a6);
    border-radius: 0 8px 8px 0;
    color: var(--text-primary);
  }

  .wiki-content blockquote p:last-child {
    margin-bottom: 0;
  }

  .wiki-content blockquote code {
    background-color: rgba(var(--color-primary-rgb, 20, 184, 166), 0.15);
  }

  /* Inline code */
  .wiki-content code:not(pre code) {
    font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace;
    padding: 0.2em 0.4em;
    margin: 0 0.1em;
    font-size: 0.875em;
    background-color: rgba(var(--color-primary-rgb, 20, 184, 166), 0.1);
    color: var(--color-primary, #14b8a6);
    border-radius: 4px;
    border: 1px solid rgba(var(--color-primary-rgb, 20, 184, 166), 0.2);
    font-weight: 500;
  }

  /* Links */
  .wiki-content a {
    color: var(--color-primary, #14b8a6);
    text-decoration: underline;
    text-decoration-color: rgba(var(--color-primary-rgb, 20, 184, 166), 0.3);
    text-underline-offset: 2px;
    font-weight: 500;
    transition: all 0.2s ease;
  }

  .wiki-content a:hover {
    text-decoration-color: var(--color-primary, #14b8a6);
    color: var(--color-primary-hover, #0d9488);
  }

  /* Images */
  .wiki-content img {
    max-width: 100%;
    height: auto;
    border-radius: 12px;
    margin: 1.5em 0;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    border: 1px solid var(--border);
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }

  .wiki-content img:hover {
    transform: scale(1.01);
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
  }

  /* Horizontal rule */
  .wiki-content hr {
    height: 0;
    margin: 2.5em 0;
    border: 0;
    border-top: 1px solid transparent;
    background: linear-gradient(to right, transparent, var(--border), transparent);
    background-size: 100% 1px;
    background-repeat: no-repeat;
  }

  /* Keyboard keys */
  .wiki-content kbd {
    display: inline-block;
    padding: 0.2em 0.5em;
    font-size: 0.8em;
    font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
    color: var(--text-primary);
    background: linear-gradient(to bottom, var(--surface), var(--surface-hover));
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: 0 2px 0 var(--border);
  }

  /* Task lists */
  .wiki-content input[type="checkbox"] {
    margin-right: 0.5em;
    width: 1em;
    height: 1em;
    accent-color: var(--color-primary, #14b8a6);
  }

  /* Definition lists */
  .wiki-content dl {
    margin: 1.5em 0;
  }

  .wiki-content dt {
    font-weight: 600;
    margin-top: 1em;
    color: var(--text-primary);
  }

  .wiki-content dd {
    margin-left: 1.5em;
    margin-bottom: 0.5em;
    color: var(--text-secondary);
  }

  /* Mermaid diagram styling */
  .mermaid {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100px;
  }

  .mermaid svg {
    max-width: 100%;
    height: auto;
  }

  /* Mermaid node styling */
  .mermaid .node rect,
  .mermaid .node polygon,
  .mermaid .node circle,
  .mermaid .node ellipse {
    fill: var(--mermaid-node-bg) !important;
    stroke: var(--mermaid-node-border) !important;
    stroke-width: 2px;
  }

  .mermaid .node .label {
    color: var(--mermaid-text) !important;
  }

  .mermaid .edgePath .path {
    stroke: var(--mermaid-line) !important;
    stroke-width: 2px;
  }

  .mermaid .edgeLabel {
    background-color: var(--mermaid-bg) !important;
    color: var(--mermaid-text) !important;
  }

  .mermaid .cluster rect {
    fill: var(--mermaid-node-bg) !important;
    stroke: var(--mermaid-border) !important;
  }

  /* Selection styling */
  .wiki-content ::selection {
    background-color: rgba(var(--color-primary-rgb, 20, 184, 166), 0.2);
  }

  /* Smooth scroll for anchor links */
  .wiki-content {
    scroll-behavior: smooth;
  }

  /* Focus styles for accessibility */
  .wiki-content a:focus-visible {
    outline: 2px solid var(--color-primary, #14b8a6);
    outline-offset: 2px;
    border-radius: 2px;
  }

  /* Print styles */
  @media print {
    .wiki-content {
      color: #000;
      background: #fff;
    }

    .wiki-content a {
      color: #000;
      text-decoration: underline;
    }

    .wiki-content code {
      background-color: #f5f5f5;
      border: 1px solid #ddd;
    }
  }
`
