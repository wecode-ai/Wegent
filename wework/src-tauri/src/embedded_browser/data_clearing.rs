use std::{
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;
use tauri::{LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, Wry};
use tokio::{sync::oneshot, time::timeout};

#[cfg(target_os = "windows")]
use webview2_com::{Microsoft::Web::WebView2::Win32::*, *};
#[cfg(target_os = "windows")]
use windows::core::Interface;

use super::{
    browser_data_directory, EmbeddedBrowserEntry, EmbeddedBrowserReadiness, EmbeddedBrowserState,
    EMBEDDED_BROWSER_DATA_STORE_ID, EMBEDDED_BROWSER_NOT_READY_ERROR, MAIN_WINDOW_LABEL,
};

const CLEAR_DATA_COMPLETION_TIMEOUT: Duration = Duration::from_secs(30);

type ClearCompletionSender = Arc<Mutex<Option<oneshot::Sender<Result<(), String>>>>>;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EmbeddedBrowserDataKind {
    Cookies,
    Cache,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct DataKindSet {
    all: bool,
    cookies: bool,
    cache: bool,
}

impl DataKindSet {
    fn from_requested(kinds: Option<Vec<EmbeddedBrowserDataKind>>) -> Self {
        let Some(kinds) = kinds else {
            return Self {
                all: true,
                cookies: true,
                cache: true,
            };
        };
        if kinds.is_empty() {
            return Self {
                all: true,
                cookies: true,
                cache: true,
            };
        }

        kinds
            .into_iter()
            .fold(Self::default(), |mut data_kinds, kind| {
                match kind {
                    EmbeddedBrowserDataKind::Cookies => data_kinds.cookies = true,
                    EmbeddedBrowserDataKind::Cache => data_kinds.cache = true,
                }
                data_kinds
            })
    }

    fn is_all(self) -> bool {
        self.all
    }
}

pub async fn clear_embedded_browser_data(
    app: tauri::AppHandle,
    state: tauri::State<'_, EmbeddedBrowserState>,
    requested_kinds: Option<Vec<EmbeddedBrowserDataKind>>,
) -> Result<usize, String> {
    let data_kinds = DataKindSet::from_requested(requested_kinds);
    let _lifecycle = state.lifecycle.lock().await;
    let webviews = {
        let webviews = state
            .webviews
            .lock()
            .map_err(|_| "Embedded browser state lock poisoned".to_string())?;
        if webviews
            .values()
            .any(|entry| entry.readiness() == EmbeddedBrowserReadiness::Opening)
        {
            return Err(EMBEDDED_BROWSER_NOT_READY_ERROR.to_string());
        }
        webviews
            .values()
            .map(EmbeddedBrowserEntry::ready_webview)
            .collect::<Result<Vec<_>, _>>()?
    };

    if !webviews.is_empty() {
        for webview in &webviews {
            clear_webview_data(webview, data_kinds).await?;
        }
        return Ok(webviews.len());
    }

    let window = app
        .get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main window not found".to_string())?;
    let cleanup_label = format!(
        "browser-data-cleanup-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let cleanup_url = tauri::Url::parse("about:blank")
        .map_err(|error| format!("Failed to create browser cleanup URL: {error}"))?;
    let builder =
        tauri::webview::WebviewBuilder::new(&cleanup_label, WebviewUrl::External(cleanup_url))
            .data_directory(browser_data_directory(&app)?)
            .data_store_identifier(EMBEDDED_BROWSER_DATA_STORE_ID);
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(-10_000.0, -10_000.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| format!("Failed to create browser data cleanup view: {error}"))?;
    webview
        .hide()
        .map_err(|error| format!("Failed to hide browser data cleanup view: {error}"))?;
    let clear_result = clear_webview_data(&webview, data_kinds).await;
    let close_result = webview
        .close()
        .map_err(|error| format!("Failed to close browser data cleanup view: {error}"));
    clear_result?;
    close_result?;
    Ok(0)
}

async fn clear_webview_data(webview: &Webview<Wry>, data_kinds: DataKindSet) -> Result<(), String> {
    if data_kinds.is_all() {
        return webview
            .clear_all_browsing_data()
            .map_err(|error| format!("Failed to clear embedded browser data: {error}"));
    }
    clear_platform_webview_data(webview, data_kinds).await
}

async fn wait_for_clear_completion(
    receiver: oneshot::Receiver<Result<(), String>>,
) -> Result<(), String> {
    timeout(CLEAR_DATA_COMPLETION_TIMEOUT, receiver)
        .await
        .map_err(|_| "Timed out while clearing embedded browser data".to_string())?
        .map_err(|_| "Embedded browser data clearing callback was dropped".to_string())?
}

fn send_clear_completion(sender: &ClearCompletionSender, result: Result<(), String>) {
    let Ok(mut sender) = sender.lock() else {
        return;
    };
    if let Some(sender) = sender.take() {
        let _ = sender.send(result);
    }
}

#[cfg(target_os = "macos")]
async fn clear_platform_webview_data(
    webview: &Webview<Wry>,
    data_kinds: DataKindSet,
) -> Result<(), String> {
    use block2::RcBlock;
    use objc2_foundation::{NSDate, NSSet, NSString, NSURLCache};
    use objc2_web_kit::{
        WKWebView, WKWebsiteDataTypeCookies, WKWebsiteDataTypeDiskCache,
        WKWebsiteDataTypeFetchCache, WKWebsiteDataTypeMemoryCache,
        WKWebsiteDataTypeOfflineWebApplicationCache,
    };

    let (sender, receiver) = oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    webview
        .with_webview(move |platform_webview| {
            let Some(native_webview) =
                (unsafe { platform_webview.inner().cast::<WKWebView>().as_ref() })
            else {
                send_clear_completion(
                    &sender,
                    Err("Embedded browser native view is unavailable".to_string()),
                );
                return;
            };
            let mut data_types: Vec<&NSString> = Vec::with_capacity(5);
            if data_kinds.cookies {
                data_types.push(unsafe { WKWebsiteDataTypeCookies });
            }
            if data_kinds.cache {
                data_types.push(unsafe { WKWebsiteDataTypeDiskCache });
                data_types.push(unsafe { WKWebsiteDataTypeFetchCache });
                data_types.push(unsafe { WKWebsiteDataTypeMemoryCache });
                data_types.push(unsafe { WKWebsiteDataTypeOfflineWebApplicationCache });
            }
            let data_types = NSSet::from_slice(&data_types);
            let date = NSDate::dateWithTimeIntervalSince1970(0.0);
            let completion_sender = Arc::clone(&sender);
            let completion_handler = RcBlock::new(move || {
                send_clear_completion(&completion_sender, Ok(()));
            });
            unsafe {
                native_webview
                    .configuration()
                    .websiteDataStore()
                    .removeDataOfTypes_modifiedSince_completionHandler(
                        &data_types,
                        &date,
                        &completion_handler,
                    );
            }
            if data_kinds.cache {
                NSURLCache::sharedURLCache().removeAllCachedResponses();
            }
        })
        .map_err(|error| format!("Failed to access embedded browser data store: {error}"))?;
    wait_for_clear_completion(receiver).await
}

#[cfg(target_os = "windows")]
async fn clear_platform_webview_data(
    webview: &Webview<Wry>,
    data_kinds: DataKindSet,
) -> Result<(), String> {
    let (sender, receiver) = oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    webview
        .with_webview(move |platform_webview| {
            let result = unsafe {
                platform_webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.cast::<ICoreWebView2_13>())
                    .and_then(|core| core.Profile())
                    .and_then(|profile| profile.cast::<ICoreWebView2Profile2>())
            };
            let profile = match result {
                Ok(profile) => profile,
                Err(error) => {
                    send_clear_completion(
                        &sender,
                        Err(format!(
                            "Failed to access embedded browser profile: {error}"
                        )),
                    );
                    return;
                }
            };
            let kinds = windows_data_kinds(data_kinds);
            let completion_sender = Arc::clone(&sender);
            let handler = ClearBrowsingDataCompletedHandler::create(Box::new(
                move |result: windows::core::Result<()>| -> windows::core::Result<()> {
                    let completion = result
                        .map_err(|error| format!("Failed to clear embedded browser data: {error}"));
                    send_clear_completion(&completion_sender, completion);
                    Ok(())
                },
            ));
            if let Err(error) = unsafe { profile.ClearBrowsingData(kinds, &handler) } {
                send_clear_completion(
                    &sender,
                    Err(format!("Failed to clear embedded browser data: {error}")),
                );
            }
        })
        .map_err(|error| format!("Failed to access embedded browser data store: {error}"))?;
    wait_for_clear_completion(receiver).await
}

#[cfg(target_os = "windows")]
fn windows_data_kinds(data_kinds: DataKindSet) -> COREWEBVIEW2_BROWSING_DATA_KINDS {
    let mut kinds = 0;
    if data_kinds.cookies {
        kinds |= COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES.0;
    }
    if data_kinds.cache {
        kinds |= COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE.0;
        kinds |= COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE.0;
    }
    COREWEBVIEW2_BROWSING_DATA_KINDS(kinds)
}

#[cfg(target_os = "linux")]
async fn clear_platform_webview_data(
    webview: &Webview<Wry>,
    data_kinds: DataKindSet,
) -> Result<(), String> {
    use webkit2gtk::{
        gio::Cancellable, glib::TimeSpan, WebContextExt, WebViewExt, WebsiteDataManagerExtManual,
    };

    let (sender, receiver) = oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    webview
        .with_webview(move |platform_webview| {
            let native_webview = platform_webview.inner();
            let Some(context) = native_webview.context() else {
                send_clear_completion(
                    &sender,
                    Err("Embedded browser WebKit context is unavailable".to_string()),
                );
                return;
            };
            let Some(manager) = context.website_data_manager() else {
                send_clear_completion(
                    &sender,
                    Err("Embedded browser data manager is unavailable".to_string()),
                );
                return;
            };
            let completion_sender = Arc::clone(&sender);
            manager.clear(
                linux_data_kinds(data_kinds),
                TimeSpan::from_seconds(0),
                None::<&Cancellable>,
                move |result| {
                    let completion = result
                        .map_err(|error| format!("Failed to clear embedded browser data: {error}"));
                    send_clear_completion(&completion_sender, completion);
                },
            );
        })
        .map_err(|error| format!("Failed to access embedded browser data store: {error}"))?;
    wait_for_clear_completion(receiver).await
}

#[cfg(target_os = "linux")]
fn linux_data_kinds(data_kinds: DataKindSet) -> webkit2gtk::WebsiteDataTypes {
    let mut kinds = webkit2gtk::WebsiteDataTypes::empty();
    if data_kinds.cookies {
        kinds |= webkit2gtk::WebsiteDataTypes::COOKIES;
    }
    if data_kinds.cache {
        kinds |= webkit2gtk::WebsiteDataTypes::DOM_CACHE;
        kinds |= webkit2gtk::WebsiteDataTypes::DISK_CACHE;
        kinds |= webkit2gtk::WebsiteDataTypes::MEMORY_CACHE;
        kinds |= webkit2gtk::WebsiteDataTypes::OFFLINE_APPLICATION_CACHE;
    }
    kinds
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
async fn clear_platform_webview_data(
    _webview: &Webview<Wry>,
    _data_kinds: DataKindSet,
) -> Result<(), String> {
    Err("Selective embedded browser data clearing is unsupported on this platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_all_data_when_kinds_are_not_provided() {
        assert_eq!(
            DataKindSet::from_requested(None),
            DataKindSet {
                all: true,
                cookies: true,
                cache: true,
            }
        );
        assert_eq!(
            DataKindSet::from_requested(Some(vec![])),
            DataKindSet {
                all: true,
                cookies: true,
                cache: true,
            }
        );
    }

    #[test]
    fn selects_only_requested_data_kinds() {
        assert_eq!(
            DataKindSet::from_requested(Some(vec![EmbeddedBrowserDataKind::Cookies])),
            DataKindSet {
                all: false,
                cookies: true,
                cache: false,
            }
        );
        assert_eq!(
            DataKindSet::from_requested(Some(vec![EmbeddedBrowserDataKind::Cache])),
            DataKindSet {
                all: false,
                cookies: false,
                cache: true,
            }
        );
    }

    #[test]
    fn merges_duplicate_requested_data_kinds() {
        assert_eq!(
            DataKindSet::from_requested(Some(vec![
                EmbeddedBrowserDataKind::Cookies,
                EmbeddedBrowserDataKind::Cookies,
                EmbeddedBrowserDataKind::Cache,
            ])),
            DataKindSet {
                all: false,
                cookies: true,
                cache: true,
            }
        );
    }
}
