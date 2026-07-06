use tauri::{Emitter, Manager};

const URL_CHANGED_EVENT: &str = "in-app-browser-url-changed";
const TITLE_CHANGED_EVENT: &str = "in-app-browser-title-changed";
const FAVICON_CHANGED_EVENT: &str = "in-app-browser-favicon-changed";

const INIT_SCRIPT: &str = r#"
(() => {
  if (window.__wegentInAppBrowserPatched) return;
  window.__wegentInAppBrowserPatched = true;

  const navigate = (rawUrl) => {
    if (!rawUrl) return false;
    try {
      const nextUrl = new URL(String(rawUrl), window.location.href).href;
      window.location.assign(nextUrl);
    } catch {
      return false;
    }
    return true;
  };

  const originalOpen = window.open;
  window.open = (url, target, features) => {
    if (navigate(url)) return null;
    return originalOpen.call(window, url, target, features);
  };
})();
"#;

#[derive(Clone, serde::Serialize)]
struct InAppBrowserUrlChangedPayload {
    label: String,
    url: String,
}

#[derive(Clone, serde::Serialize)]
struct InAppBrowserTitleChangedPayload {
    label: String,
    title: Option<String>,
}

#[derive(Clone, serde::Serialize)]
struct InAppBrowserFaviconChangedPayload {
    label: String,
    favicon_url: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct BrowserFrameRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn get_browser_webview(app: tauri::AppHandle, label: &str) -> Result<tauri::Webview, String> {
    app.get_webview(label)
        .ok_or_else(|| format!("In-app browser webview not found: {label}"))
}

fn eval_browser_script(app: tauri::AppHandle, label: String, script: &str) -> Result<(), String> {
    let webview = get_browser_webview(app, &label)?;

    webview
        .eval(script)
        .map_err(|error| format!("Failed to control in-app browser: {error}"))
}

fn parse_eval_string(value: String) -> Option<String> {
    let parsed = serde_json::from_str::<String>(&value).unwrap_or(value);
    let trimmed = parsed.trim();

    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn emit_browser_url(app: &tauri::AppHandle, label: &str, url: &str) {
    let _ = app.emit(
        URL_CHANGED_EVENT,
        InAppBrowserUrlChangedPayload {
            label: label.to_string(),
            url: url.to_string(),
        },
    );
}

fn emit_browser_title(app: &tauri::AppHandle, label: &str, title: Option<String>) {
    let _ = app.emit(
        TITLE_CHANGED_EVENT,
        InAppBrowserTitleChangedPayload {
            label: label.to_string(),
            title,
        },
    );
}

fn emit_browser_favicon(app: tauri::AppHandle, label: String, webview: tauri::Webview) {
    let label_for_callback = label.clone();
    let _ = webview.eval_with_callback(
        r#"
        Array.from(document.querySelectorAll('link[rel][href]'))
          .find((link) => /\b(?:shortcut\s+icon|icon|apple-touch-icon)\b/i.test(link.rel))
          ?.href || new URL('/favicon.ico', window.location.href).href
        "#,
        move |value| {
            let _ = app.emit(
                FAVICON_CHANGED_EVENT,
                InAppBrowserFaviconChangedPayload {
                    label: label_for_callback.clone(),
                    favicon_url: parse_eval_string(value),
                },
            );
        },
    );
}

#[tauri::command]
pub fn in_app_browser_create(
    app: tauri::AppHandle,
    label: String,
    url: String,
    rect: BrowserFrameRect,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview(&label) {
        let _ = existing.close();
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    let parsed_url = url
        .parse()
        .map_err(|error| format!("Invalid in-app browser URL: {error}"))?;

    let app_for_navigation = app.clone();
    let label_for_navigation = label.clone();
    let app_for_new_window = app.clone();
    let label_for_new_window = label.clone();
    let app_for_title = app.clone();
    let label_for_title = label.clone();
    let app_for_page_load = app.clone();
    let label_for_page_load = label.clone();

    let mut builder = tauri::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed_url))
        .accept_first_mouse(true)
        .focused(false)
        .initialization_script(INIT_SCRIPT)
        .on_navigation(move |next_url| {
            emit_browser_url(
                &app_for_navigation,
                &label_for_navigation,
                next_url.as_str(),
            );
            true
        })
        .on_new_window(move |next_url, _features| {
            emit_browser_url(
                &app_for_new_window,
                &label_for_new_window,
                next_url.as_str(),
            );
            if let Some(webview) = app_for_new_window.get_webview(&label_for_new_window) {
                let _ = webview.navigate(next_url);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_document_title_changed(move |_webview, title| {
            emit_browser_title(&app_for_title, &label_for_title, parse_eval_string(title));
        })
        .on_page_load(move |webview, payload| {
            emit_browser_url(
                &app_for_page_load,
                &label_for_page_load,
                payload.url().as_str(),
            );
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                emit_browser_favicon(
                    app_for_page_load.clone(),
                    label_for_page_load.clone(),
                    webview,
                );
            }
        });

    #[cfg(any(debug_assertions, feature = "release-devtools"))]
    {
        builder = builder.devtools(true);
    }

    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(rect.x, rect.y),
            tauri::LogicalSize::new(rect.width, rect.height),
        )
        .map_err(|error| format!("Failed to create in-app browser: {error}"))?;

    emit_browser_url(&app, &label, &url);
    Ok(())
}

#[tauri::command]
pub fn in_app_browser_set_frame(
    app: tauri::AppHandle,
    label: String,
    rect: BrowserFrameRect,
) -> Result<(), String> {
    let webview = get_browser_webview(app, &label)?;

    webview
        .set_bounds(tauri::Rect {
            position: tauri::Position::Logical(tauri::LogicalPosition::new(rect.x, rect.y)),
            size: tauri::Size::Logical(tauri::LogicalSize::new(rect.width, rect.height)),
        })
        .map_err(|error| format!("Failed to resize in-app browser: {error}"))
}

#[tauri::command]
pub fn in_app_browser_go_back(app: tauri::AppHandle, label: String) -> Result<(), String> {
    eval_browser_script(app, label, "window.history.back()")
}

#[tauri::command]
pub fn in_app_browser_go_forward(app: tauri::AppHandle, label: String) -> Result<(), String> {
    eval_browser_script(app, label, "window.history.forward()")
}

#[tauri::command]
pub fn in_app_browser_reload(app: tauri::AppHandle, label: String) -> Result<(), String> {
    eval_browser_script(app, label, "window.location.reload()")
}

#[tauri::command]
pub async fn in_app_browser_page_title(
    app: tauri::AppHandle,
    label: String,
) -> Result<Option<String>, String> {
    let webview = get_browser_webview(app, &label)?;
    let (tx, mut rx) = tauri::async_runtime::channel::<String>(1);

    webview
        .eval_with_callback("document.title || ''", move |value| {
            let _ = tx.try_send(value);
        })
        .map_err(|error| format!("Failed to read in-app browser title: {error}"))?;

    Ok(rx.recv().await.and_then(parse_eval_string))
}

#[tauri::command]
pub async fn in_app_browser_page_favicon(
    app: tauri::AppHandle,
    label: String,
) -> Result<Option<String>, String> {
    let webview = get_browser_webview(app, &label)?;
    let (tx, mut rx) = tauri::async_runtime::channel::<String>(1);

    webview
        .eval_with_callback(
            r#"
            Array.from(document.querySelectorAll('link[rel][href]'))
              .find((link) => /\b(?:shortcut\s+icon|icon|apple-touch-icon)\b/i.test(link.rel))
              ?.href || ''
            "#,
            move |value| {
                let _ = tx.try_send(value);
            },
        )
        .map_err(|error| format!("Failed to read in-app browser favicon: {error}"))?;

    Ok(rx.recv().await.and_then(parse_eval_string))
}
