use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, Local};
use encoding_rs::{GB18030, UTF_16BE, UTF_16LE};
use mime_guess::MimeGuess;

const EMBEDDED_BROWSER_TEXT_PREVIEW_LIMIT: usize = 256 * 1024;
const EMBEDDED_BROWSER_DIRECTORY_INDEX_LIMIT: usize = 1_000;
static LOCAL_FILE_PREVIEW_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn escape_html(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '&' => "&amp;".to_string(),
            '<' => "&lt;".to_string(),
            '>' => "&gt;".to_string(),
            '"' => "&quot;".to_string(),
            '\'' => "&#39;".to_string(),
            _ => character.to_string(),
        })
        .collect()
}

pub(crate) fn browser_file_url_from_path(path: &Path) -> Result<tauri::Url, String> {
    tauri::Url::from_file_path(path)
        .map_err(|_| format!("Failed to create file URL from path: {}", path.display()))
}

pub(crate) fn browser_directory_cache_directory() -> Result<PathBuf, String> {
    Ok(std::env::temp_dir().join("wework-embedded-browser"))
}

pub(crate) fn is_generated_preview_path(path: &Path) -> bool {
    browser_directory_cache_directory()
        .map(|cache_directory| path.starts_with(cache_directory))
        .unwrap_or(false)
}

pub(crate) fn file_url_path(url: &tauri::Url) -> Result<PathBuf, String> {
    if url.scheme() != "file" {
        return Err("Embedded browser URL is not a file URL".to_string());
    }
    url.to_file_path()
        .map_err(|_| format!("Unable to convert file URL to a path: {url}"))
}

pub(crate) fn local_file_browser_title(url: &tauri::Url) -> Option<String> {
    let path = file_url_path(url).ok()?;
    if path.is_dir() {
        return Some(format!("Index of {}", path.display()));
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .or_else(|| Some(path.display().to_string()))
}

#[derive(Clone)]
pub(crate) struct DirectoryEntry {
    pub(crate) name: String,
    pub(crate) url: String,
    pub(crate) is_directory: bool,
    pub(crate) size: Option<u64>,
    pub(crate) modified: Option<String>,
    pub(crate) modified_unix_seconds: Option<u64>,
}

pub(crate) fn format_directory_entry_modified(
    modified: std::io::Result<SystemTime>,
) -> Option<String> {
    let modified = modified.ok()?;
    let modified: DateTime<Local> = modified.into();
    Some(modified.format("%Y/%-m/%-d %H:%M:%S").to_string())
}

pub(crate) fn directory_entry_modified_unix_seconds(
    modified: std::io::Result<SystemTime>,
) -> Option<u64> {
    modified
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

pub(crate) fn format_file_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "kB", "MB", "GB", "TB"];

    let mut value = bytes as f64;
    let mut unit_index = 0;
    while value >= 1000.0 && unit_index < UNITS.len() - 1 {
        value /= 1000.0;
        unit_index += 1;
    }

    if unit_index == 0 || value >= 100.0 {
        format!("{value:.0} {}", UNITS[unit_index])
    } else {
        format!("{value:.1} {}", UNITS[unit_index])
    }
}

fn previewable_mime(mime: &str) -> bool {
    mime.starts_with("text/")
        || mime == "application/json"
        || mime.ends_with("+json")
        || mime.ends_with("+xml")
        || mime == "application/xml"
}

pub(crate) fn is_natively_renderable_html(path: &Path) -> bool {
    matches!(
        MimeGuess::from_path(path).first_raw(),
        Some("text/html" | "application/xhtml+xml")
    )
}

fn read_preview_bytes(path: &Path) -> Result<(Vec<u8>, bool), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to inspect file {}: {error}", path.display()))?;
    let file = fs::File::open(path)
        .map_err(|error| format!("Failed to open file {}: {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.take((EMBEDDED_BROWSER_TEXT_PREVIEW_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read file {}: {error}", path.display()))?;
    let truncated = metadata.len() as usize > EMBEDDED_BROWSER_TEXT_PREVIEW_LIMIT
        || bytes.len() > EMBEDDED_BROWSER_TEXT_PREVIEW_LIMIT;
    if bytes.len() > EMBEDDED_BROWSER_TEXT_PREVIEW_LIMIT {
        bytes.truncate(EMBEDDED_BROWSER_TEXT_PREVIEW_LIMIT);
    }
    Ok((bytes, truncated))
}

fn utf8_or_gb18030_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = UTF_16LE.decode(&bytes[2..]);
        return text.into_owned();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = UTF_16BE.decode(&bytes[2..]);
        return text.into_owned();
    }
    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        return text;
    }
    let (text, _, _) = GB18030.decode(bytes);
    text.into_owned()
}

fn text_preview_is_plausible(text: &str) -> bool {
    let mut total = 0usize;
    let mut suspicious = 0usize;
    for character in text.chars().take(4096) {
        total += 1;
        if character == '\u{FFFD}'
            || (character.is_control()
                && character != '\n'
                && character != '\r'
                && character != '\t')
        {
            suspicious += 1;
        }
    }
    total == 0 || suspicious * 8 <= total
}

fn file_preview_is_text(path: &Path, bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true;
    }
    let has_utf16_bom = bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]);
    if bytes.contains(&0) && !has_utf16_bom {
        return false;
    }

    let path_mime = MimeGuess::from_path(path).first_raw();
    if path_mime.is_some_and(previewable_mime) {
        return true;
    }

    let inferred_mime = infer::get(bytes).map(|kind| kind.mime_type().to_string());
    if inferred_mime.as_deref().is_some_and(previewable_mime) {
        return true;
    }

    if std::str::from_utf8(bytes).is_ok() {
        return true;
    }

    let decoded = utf8_or_gb18030_text(bytes);
    text_preview_is_plausible(&decoded)
}

fn text_preview_html(file_path: &Path, decoded_text: &str, truncated: bool) -> String {
    let title_source = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_owned)
        .unwrap_or_else(|| file_path.display().to_string());
    let title = escape_html(&title_source);
    let body = escape_html(decoded_text);
    let truncated_notice = if truncated {
        "<p class=\"notice\">Showing the first 256 KiB.</p>"
    } else {
        ""
    };

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f6f7f8;
      --panel: #ffffff;
      --line: #d9dee3;
      --text: #1f2328;
      --muted: #66707a;
    }}
    body {{
      margin: 0;
      font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg);
      color: var(--text);
    }}
    main {{
      padding: 20px;
    }}
    pre {{
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      font: 13px/1.7 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }}
    .notice {{
      margin: 0 0 12px;
      color: var(--muted);
      font-size: 12px;
    }}
  </style>
</head>
<body>
  <main>
    {truncated_notice}
    <pre>{body}</pre>
  </main>
</body>
</html>"#
    )
}

pub(crate) fn build_text_preview(
    file_url: &tauri::Url,
) -> Result<Option<(tauri::Url, String)>, String> {
    let path = file_url_path(file_url)?;
    if !path.is_file() {
        return Ok(None);
    }
    let (bytes, truncated) = read_preview_bytes(&path)?;
    if !file_preview_is_text(&path, &bytes) {
        return Ok(None);
    }

    let decoded = utf8_or_gb18030_text(&bytes);
    let html = text_preview_html(&path, &decoded, truncated);
    let cache_directory = browser_directory_cache_directory()?;
    fs::create_dir_all(&cache_directory)
        .map_err(|error| format!("Failed to create embedded browser directory cache: {error}"))?;
    let preview_path = cache_directory.join(format!(
        "text-{}-{}.html",
        std::process::id(),
        LOCAL_FILE_PREVIEW_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&preview_path, html)
        .map_err(|error| format!("Failed to write embedded browser text preview: {error}"))?;

    browser_file_url_from_path(&preview_path).map(|url| Some((url, file_url.to_string())))
}

fn build_directory_entries(directory: &Path) -> Result<(Vec<DirectoryEntry>, bool), String> {
    let mut entries = Vec::new();
    let mut children = fs::read_dir(directory)
        .map_err(|error| {
            format!(
                "Failed to inspect directory {}: {error}",
                directory.display()
            )
        })?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();

    children.sort_by_key(|entry| {
        (
            entry.file_type().map(|kind| !kind.is_dir()).unwrap_or(true),
            entry.file_name(),
        )
    });

    for entry in children
        .into_iter()
        .take(EMBEDDED_BROWSER_DIRECTORY_INDEX_LIMIT)
    {
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "Failed to inspect directory entry {}: {error}",
                entry.path().display()
            )
        })?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let child_url = browser_file_url_from_path(&path)?.to_string();
        let metadata = entry.metadata().ok();
        let is_directory = file_type.is_dir();
        entries.push(DirectoryEntry {
            name: if is_directory {
                format!("{name}/")
            } else {
                name
            },
            url: if is_directory {
                format!("{child_url}/")
            } else {
                child_url
            },
            is_directory,
            size: metadata
                .as_ref()
                .and_then(|metadata| (!is_directory).then_some(metadata.len())),
            modified: metadata
                .as_ref()
                .and_then(|metadata| format_directory_entry_modified(metadata.modified())),
            modified_unix_seconds: metadata
                .as_ref()
                .and_then(|metadata| directory_entry_modified_unix_seconds(metadata.modified())),
        });
    }

    let truncated = directory.read_dir().map(|iter| iter.count()).unwrap_or(0) > entries.len();
    Ok((entries, truncated))
}

pub(crate) fn directory_listing_html(
    directory: &Path,
    entries: &[DirectoryEntry],
    truncated: bool,
) -> String {
    let title = escape_html(&format!("Index of {}", directory.display()));
    let parent_url = directory
        .parent()
        .and_then(|parent| browser_file_url_from_path(parent).ok());
    let parent_link = parent_url
        .map(|url| {
            format!(
                "<a class=\"parent-link\" data-testid=\"embedded-browser-directory-parent\" href=\"{}\"><span class=\"icon icon-parent\" aria-hidden=\"true\"></span><span>Parent directory</span></a>",
                escape_html(url.as_str())
            )
        })
        .unwrap_or_default();
    let rows = entries
        .iter()
        .map(|entry| {
            let size = entry.size.map(format_file_size).unwrap_or_default();
            let modified = entry.modified.clone().unwrap_or_default();
            let icon = if entry.is_directory {
                "icon-directory"
            } else {
                "icon-file"
            };
            format!(
                "<tr data-name=\"{name}\" data-size=\"{size_value}\" data-modified=\"{modified_value}\"><td><a class=\"entry-link\" data-testid=\"embedded-browser-directory-entry\" href=\"{url}\"><span class=\"icon {icon}\" aria-hidden=\"true\"></span><span class=\"name\">{name}</span></a></td><td class=\"details\">{size}</td><td class=\"details modified\">{modified}</td></tr>",
                url = escape_html(&entry.url),
                name = escape_html(&entry.name),
                size = escape_html(&size),
                modified = escape_html(&modified),
                size_value = entry.size.unwrap_or(0),
                modified_value = entry.modified_unix_seconds.unwrap_or(0),
            )
        })
        .collect::<String>();
    let truncated_notice = if truncated {
        "<p class=\"notice\">Showing the first 1,000 entries.</p>"
    } else {
        ""
    };

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    :root {{
      color-scheme: light dark;
      --background: #ffffff;
      --text: #1a1c1f;
      --muted: #5d5d5d;
      --line: #ededed;
      --hover: #f9f9f9;
      --link: #0969da;
      --icon-stroke: #5d5d5d;
      --icon-fill: #e5f3ff;
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        --background: #181818;
        --text: #ffffff;
        --muted: #afafaf;
        --line: #303030;
        --hover: #212121;
        --link: #339cff;
        --icon-stroke: #afafaf;
        --icon-fill: #00284d;
      }}
    }}
    body {{
      margin: 0;
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--background);
      color: var(--text);
    }}
    main {{
      padding: 20px;
      overflow-x: auto;
    }}
    h1 {{
      margin: 0 0 12px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--line);
      font-size: 18px;
      font-weight: 500;
      word-break: break-all;
    }}
    .parent-link {{
      display: inline-flex;
      min-height: 30px;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
      color: var(--link);
      text-decoration: none;
    }}
    .parent-link:hover {{
      text-decoration: underline;
    }}
    table {{
      width: 100%;
      min-width: 460px;
      border-collapse: collapse;
      table-layout: fixed;
    }}
    th {{
      padding: 0 8px 4px;
      text-align: left;
      font-weight: 500;
    }}
    th:first-child {{
      padding-left: 0;
    }}
    th.details {{
      width: 140px;
      text-align: right;
    }}
    .sort-button {{
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 0;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font: inherit;
    }}
    th.details .sort-button {{
      margin-left: auto;
    }}
    .sort-button:hover {{
      color: var(--text);
    }}
    .sort-button:focus-visible {{
      outline: 2px solid var(--link);
      outline-offset: 2px;
    }}
    .sort-indicator {{
      width: 12px;
      color: var(--muted);
      text-align: center;
    }}
    .sort-indicator::before {{
      content: '↕';
    }}
    .sort-button[data-order='asc'] .sort-indicator::before {{
      content: '↑';
    }}
    .sort-button[data-order='desc'] .sort-indicator::before {{
      content: '↓';
    }}
    td {{
      padding: 6px 8px;
      border-top: 1px solid var(--line);
      vertical-align: middle;
    }}
    td:first-child {{
      padding-left: 0;
    }}
    tr:hover td {{
      background: var(--hover);
    }}
    td.details {{
      color: var(--muted);
      text-align: right;
      white-space: nowrap;
    }}
    .entry-link {{
      display: flex;
      min-width: 0;
      min-height: 28px;
      align-items: center;
      gap: 6px;
      color: var(--link);
      text-decoration: none;
    }}
    .entry-link:hover .name {{
      text-decoration: underline;
    }}
    .entry-link:focus-visible {{
      outline: 2px solid var(--link);
      outline-offset: 2px;
    }}
    .name {{
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }}
    .icon {{
      position: relative;
      display: inline-block;
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
      color: var(--icon-stroke);
    }}
    .icon-directory::before {{
      position: absolute;
      top: 5px;
      left: 1px;
      width: 13px;
      height: 9px;
      border: 1px solid currentColor;
      border-radius: 2px;
      background: var(--icon-fill);
      content: '';
    }}
    .icon-directory::after {{
      position: absolute;
      top: 2px;
      left: 2px;
      width: 6px;
      height: 4px;
      border: 1px solid currentColor;
      border-bottom: 0;
      border-radius: 2px 2px 0 0;
      background: var(--icon-fill);
      content: '';
    }}
    .icon-file::before {{
      position: absolute;
      top: 1px;
      left: 3px;
      width: 10px;
      height: 13px;
      border: 1px solid currentColor;
      border-radius: 2px;
      content: '';
    }}
    .icon-file::after {{
      position: absolute;
      top: 3px;
      left: 6px;
      width: 5px;
      border-top: 1px solid currentColor;
      content: '';
    }}
    .icon-parent::before {{
      position: absolute;
      inset: 0;
      color: var(--link);
      content: '↥';
      font-size: 16px;
      line-height: 16px;
      text-align: center;
    }}
    .notice {{
      margin: 12px 0 0;
      color: var(--muted);
      font-size: 12px;
    }}
  </style>
</head>
<body>
  <main>
    <h1>{title}</h1>
    {parent_link}
    <table id="directory-listing" aria-label="Directory listing">
      <thead>
        <tr>
          <th scope="col"><button class="sort-button" type="button" data-testid="embedded-browser-directory-sort-name" data-column="name" aria-sort="none">Name <span class="sort-indicator" aria-hidden="true"></span></button></th>
          <th class="details" scope="col"><button class="sort-button" type="button" data-testid="embedded-browser-directory-sort-size" data-column="size" aria-sort="none">Size <span class="sort-indicator" aria-hidden="true"></span></button></th>
          <th class="details" scope="col"><button class="sort-button" type="button" data-testid="embedded-browser-directory-sort-modified" data-column="modified" aria-sort="none">Modified <span class="sort-indicator" aria-hidden="true"></span></button></th>
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
    {truncated_notice}
  </main>
  <script>
    function sortDirectory(button) {{
      const column = button.dataset.column;
      const direction = button.dataset.order === 'asc' ? -1 : 1;
      const rows = Array.from(document.querySelectorAll('#directory-listing tbody tr'));
      rows.sort((first, second) => {{
        const firstValue = first.dataset[column] || '';
        const secondValue = second.dataset[column] || '';
        const comparison = column === 'name'
          ? firstValue.localeCompare(secondValue, undefined, {{ numeric: true, sensitivity: 'base' }})
          : Number(firstValue) - Number(secondValue);
        return comparison * direction;
      }});
      document.querySelectorAll('.sort-button').forEach((header) => {{
        header.dataset.order = header === button ? (direction === 1 ? 'asc' : 'desc') : '';
        header.setAttribute('aria-sort', header === button ? (direction === 1 ? 'ascending' : 'descending') : 'none');
      }});
      const body = document.querySelector('#directory-listing tbody');
      rows.forEach((row) => body.appendChild(row));
    }}
    document.querySelectorAll('.sort-button').forEach((button) => {{
      button.addEventListener('click', () => sortDirectory(button));
    }});
  </script>
</body>
</html>"#
    )
}

pub(crate) fn build_directory_preview(
    directory_url: &tauri::Url,
) -> Result<(tauri::Url, String), String> {
    let directory = file_url_path(directory_url)?;
    if !directory.is_dir() {
        return Err("File URL is not a directory".to_string());
    }

    let cache_directory = browser_directory_cache_directory()?;
    fs::create_dir_all(&cache_directory)
        .map_err(|error| format!("Failed to create embedded browser directory cache: {error}"))?;

    let preview_path = cache_directory.join(format!(
        "directory-{}-{}.html",
        std::process::id(),
        LOCAL_FILE_PREVIEW_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let (entries, truncated) = build_directory_entries(&directory)?;
    let html = directory_listing_html(&directory, &entries, truncated);
    fs::write(&preview_path, html)
        .map_err(|error| format!("Failed to write embedded browser directory preview: {error}"))?;

    browser_file_url_from_path(&preview_path).map(|url| (url, directory_url.to_string()))
}
