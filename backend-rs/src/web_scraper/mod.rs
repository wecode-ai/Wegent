// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/web-scraper/create-document`'s scraping service
//! (`app.services.web_scraper.scraper_service.WebScraperService.scrape_url`).
//!
//! Source pipeline:
//!
//! 1. `WebScraperUrlGuard.validate_initial_url` — scheme/netloc and the
//!    shared `_validate_url_for_ssrf` check from
//!    `app.services.url_metadata`;
//! 2. `SitePolicyResolver.resolve` — a pure function of the
//!    `WEB_SCRAPER_SITE_CONFIG` setting with no dependency traffic, so it
//!    has no observable effect on the recorded contract and is not ported;
//! 3. `_is_direct_pdf_url` -> `PdfExtractor.extract` (httpx + PyPDF2);
//! 4. `_check_crawl4ai` then `_get_crawler`: `AsyncWebCrawler.__init__`
//!    creates `<CRAWL4_AI_BASE_DIRECTORY|home>/.crawl4ai` and
//!    `.crawl4ai/cache`;
//! 5. the crawl4ai / Playwright strategies.
//!
//! The deployed runtime runs as UID 998 with `HOME=/root`, so step 4's first
//! `os.makedirs` raises `PermissionError [Errno 13]` for
//! `/root/.crawl4ai`; `scrape_url`'s generic handler renders
//! `FETCH_FAILED` with `"Failed to scrape page: <oserror>"`. Every
//! create-document request therefore fails at workspace creation before any
//! page fetch, which is the behavior this port reproduces.
//!
//! The browser crawl stage and the success path (attachment upload,
//! knowledge-document creation, Celery indexing) belong to a separate
//! migration batch and are unreachable while the crawler workspace cannot be
//! created. When the workspace *is* creatable, this port returns the
//! source's own `CRAWL4AI_NOT_INSTALLED` error instead of fabricating a
//! document: the Rust build ships no crawl4ai browser engine.

pub mod crawler;
mod guard;

/// `ERROR_INVALID_URL` (`app.services.web_scraper.models`).
pub const ERROR_INVALID_URL: &str = "INVALID_URL_FORMAT";
/// `ERROR_FETCH_FAILED`.
pub const ERROR_FETCH_FAILED: &str = "FETCH_FAILED";
/// `ERROR_CRAWL4AI_NOT_INSTALLED`.
pub const ERROR_CRAWL4AI_NOT_INSTALLED: &str = "CRAWL4AI_NOT_INSTALLED";
/// `ERROR_SSRF_BLOCKED`.
pub const ERROR_SSRF_BLOCKED: &str = "SSRF_BLOCKED";
/// Content abnormality: the scrape returned HTTP 200 but the extracted text is empty or pure whitespace.
pub const ERROR_CONTENT_EMPTY: &str = "CONTENT_EMPTY";

/// `_check_crawl4ai`'s message for a runtime without the crawl4ai engine.
const CRAWL4AI_NOT_INSTALLED_MESSAGE: &str =
    "Crawl4AI not installed. Install with: pip install 'crawl4ai[sync]' && crawl4ai-setup";
/// `PdfExtractor.extract`'s `ImportError` branch: the deployment has no PDF
/// text extractor. The classifier maps this result to `FETCH_FAILED` with
/// the same message.
const PDF_EXTRACTOR_UNAVAILABLE: &str = "PyPDF2 not installed, cannot extract PDF content";

/// The subset of `ScrapedContent` the create-document endpoint consumes: the
/// orchestration only branches on `success`, `error_code`, and
/// `error_message` (the success payload belongs to the unported document
/// creation flow).
#[derive(Debug)]
pub struct ScrapeOutcome {
    pub success: bool,
    pub error_code: Option<&'static str>,
    pub error_message: Option<String>,
    pub content: Option<String>,
}

impl ScrapeOutcome {
    fn error(error_code: &'static str, error_message: impl Into<String>) -> Self {
        Self {
            success: false,
            error_code: Some(error_code),
            error_message: Some(error_message.into()),
            content: None,
        }
    }
}

/// A shared HTTP client for page fetching (no redirects, trust anchors, timeouts).
fn http_client() -> Result<brz_http::Client, anyhow::Error> {
    Ok(brz_http::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(60))
        .configure(|builder| {
            let builder = builder.redirect(brz_http::reqwest::redirect::Policy::none());
            match crate::http_trust::trust_anchor() {
                Some(anchor) => builder.add_root_certificate(anchor),
                None => builder,
            }
        })
        .build()?)
}

/// Fetch a page's text content over plain HTTP (no browser rendering).
///
/// The auto-update scheduler uses this to detect content changes. Unlike
/// `scrape_url` (which requires the crawl4ai browser engine), this function
/// works without any browser dependency: it issues an HTTP GET, strips HTML
/// tags, and returns the extracted text.
pub async fn fetch_url_content(url: &str) -> ScrapeOutcome {
    if let Err(guard_error) = guard::validate_initial_url(url).await {
        return ScrapeOutcome::error(guard_error.error_code, guard_error.message);
    }

    let client = match http_client() {
        Ok(client) => client,
        Err(_) => {
            return ScrapeOutcome::error(ERROR_FETCH_FAILED, "HTTP client unavailable");
        }
    };

    let builder = match client.get(url) {
        Ok(builder) => builder,
        Err(e) => return ScrapeOutcome::error(ERROR_FETCH_FAILED, format!("Request build failed: {e}")),
    };
    let response = match builder.send().await {
        Ok(response) => response,
        Err(send_error) => {
            return ScrapeOutcome::error(
                ERROR_FETCH_FAILED,
                format!("Failed to fetch page: {send_error}"),
            );
        }
    };

    if !response.status().is_success() {
        return ScrapeOutcome::error(
            ERROR_FETCH_FAILED,
            format!("Failed to fetch page: HTTP {}", response.status()),
        );
    }

    let html = match response.text().await {
        Ok(text) => text,
        Err(read_error) => {
            return ScrapeOutcome::error(
                ERROR_FETCH_FAILED,
                format!("Failed to read page body: {read_error}"),
            );
        }
    };

    let text = strip_html(&html);
    if text.trim().is_empty() {
        return ScrapeOutcome::error(ERROR_CONTENT_EMPTY, "Extracted text is empty");
    }

    ScrapeOutcome {
        success: true,
        error_code: None,
        error_message: None,
        content: Some(text),
    }
}

/// Strip HTML tags and decode the most common entities to plain text.
fn strip_html(html: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut inside_tag = false;
    let mut chars = html.chars().peekable();
    while let Some(char) = chars.next() {
        match char {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => output.push(char),
            _ => {}
        }
    }
    decode_entities(&output)
}

/// Decode the HTML entities that appear most often in page text.
fn decode_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

/// `WebScraperService.scrape_url`: guard the URL, then run the scrape
/// strategies. The generic `except Exception` branch turns an unexpected
/// strategy failure into `FETCH_FAILED` with `"Failed to scrape page: ..."`.
pub async fn scrape_url(url: &str) -> ScrapeOutcome {
    if let Err(error) = guard::validate_initial_url(url).await {
        return ScrapeOutcome::error(error.error_code, error.message);
    }

    if is_direct_pdf_url(url) {
        return ScrapeOutcome::error(ERROR_FETCH_FAILED, PDF_EXTRACTOR_UNAVAILABLE);
    }

    // `_get_crawler` -> `AsyncWebCrawler.__init__` workspace creation. The
    // deployment's workspace is not writable, so this is where the recorded
    // request fails; the source renders the raised `OSError` verbatim.
    if let Err(error) = crawler::start().await {
        return ScrapeOutcome::error(
            ERROR_FETCH_FAILED,
            format!("Failed to scrape page: {}", error.message()),
        );
    }

    // The workspace exists, so the browser crawl stage would run in the
    // source. The Rust build has no browser engine; report the source's
    // engine-unavailable error rather than inventing a document.
    ScrapeOutcome::error(ERROR_CRAWL4AI_NOT_INSTALLED, CRAWL4AI_NOT_INSTALLED_MESSAGE)
}

/// `_is_direct_pdf_url`: `urlparse(url).path.lower().endswith(".pdf")`.
fn is_direct_pdf_url(url: &str) -> bool {
    let path = url::Url::parse(url)
        .map(|parsed| parsed.path().to_string())
        .unwrap_or_default();
    path.to_ascii_lowercase().ends_with(".pdf")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_pdf_urls_match_the_source_path_suffix() {
        assert!(is_direct_pdf_url("https://example.test/files/Report.PDF"));
        assert!(is_direct_pdf_url("https://example.test/a.pdf?download=1"));
        assert!(!is_direct_pdf_url("https://example.test/a.pdf.html"));
        assert!(!is_direct_pdf_url("https://example.test/page"));
        assert!(!is_direct_pdf_url("not a url"));
    }

    #[tokio::test]
    async fn an_invalid_url_short_circuits_before_the_crawler() {
        let outcome = scrape_url("file:///etc/passwd").await;
        assert!(!outcome.success);
        assert_eq!(outcome.error_code, Some(ERROR_INVALID_URL));
        assert_eq!(outcome.error_message.as_deref(), Some("Invalid URL format"));
    }

    #[tokio::test]
    async fn a_direct_pdf_url_uses_the_pdf_extractor_path() {
        // A public IP literal keeps the SSRF guard off DNS resolution.
        let outcome = scrape_url("https://93.184.216.34/report.pdf").await;
        assert!(!outcome.success);
        assert_eq!(outcome.error_code, Some(ERROR_FETCH_FAILED));
        assert_eq!(
            outcome.error_message.as_deref(),
            Some(PDF_EXTRACTOR_UNAVAILABLE)
        );
    }
}

    #[test]
    fn strip_html_removes_tags_and_decodes_entities() {
        assert_eq!(strip_html("<p>Hello &amp; world</p>"), "Hello & world");
        assert_eq!(strip_html("<div>a&lt;b&gt;c</div>"), "a<b>c");
        assert_eq!(strip_html(""), "");
        assert_eq!(strip_html("no tags"), "no tags");
        assert_eq!(strip_html("<script>var x=1;</script>visible"), "var x=1;visible");
        assert_eq!(strip_html("a &nbsp; b"), "a   b");
    }

    #[test]
    fn content_empty_error_has_the_right_code() {
        let outcome = ScrapeOutcome::error(ERROR_CONTENT_EMPTY, "Extracted text is empty");
        assert_eq!(outcome.error_code, Some(ERROR_CONTENT_EMPTY));
        assert!(outcome.content.is_none());
    }
