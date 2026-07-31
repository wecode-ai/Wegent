use std::{
    collections::HashMap,
    ffi::{c_void, CStr},
    sync::{Mutex, OnceLock},
};

use block2::Block;
use objc2::{
    ffi::{objc_getAssociatedObject, objc_setAssociatedObject, OBJC_ASSOCIATION_RETAIN_NONATOMIC},
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, ClassBuilder, Sel},
    sel,
};
use objc2_foundation::NSString;
use tauri::{Emitter, Webview, Wry};

use crate::embedded_browser::EmbeddedBrowserInvalidTlsCertificate;

const INVALID_TLS_CERTIFICATE_EVENT: &str = "wework:embedded-browser-invalid-tls-certificate";
const AUTH_CHALLENGE_USE_CREDENTIAL: isize = 0;
const AUTH_CHALLENGE_PERFORM_DEFAULT_HANDLING: isize = 1;
const SERVER_TRUST_AUTHENTICATION_METHOD: &str = "NSURLAuthenticationMethodServerTrust";

type AuthenticationChallengeCompletion = Block<dyn Fn(isize, *mut AnyObject)>;

#[derive(Clone)]
struct InvalidTlsWebviewContext {
    app: tauri::AppHandle,
}

static WEBVIEW_NATIVE_LABEL_KEY: u8 = 0;

fn webview_contexts() -> &'static Mutex<HashMap<String, InvalidTlsWebviewContext>> {
    static CONTEXTS: OnceLock<Mutex<HashMap<String, InvalidTlsWebviewContext>>> = OnceLock::new();
    CONTEXTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn invalid_tls_certificates(
) -> &'static Mutex<HashMap<String, EmbeddedBrowserInvalidTlsCertificate>> {
    static CERTIFICATES: OnceLock<Mutex<HashMap<String, EmbeddedBrowserInvalidTlsCertificate>>> =
        OnceLock::new();
    CERTIFICATES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SecTrustEvaluateWithError(trust: *const c_void, error: *mut *mut c_void) -> bool;
}

unsafe extern "C-unwind" fn handle_authentication_challenge(
    _delegate: &AnyObject,
    _command: Sel,
    webview: *mut AnyObject,
    challenge: *mut AnyObject,
    completion: *mut AuthenticationChallengeCompletion,
) {
    if webview.is_null() || challenge.is_null() || completion.is_null() {
        return;
    }

    let challenge = unsafe { &*challenge };
    let protection_space: Retained<AnyObject> = unsafe { msg_send![challenge, protectionSpace] };
    let authentication_method: Retained<NSString> =
        unsafe { msg_send![&*protection_space, authenticationMethod] };
    if authentication_method.to_string() != SERVER_TRUST_AUTHENTICATION_METHOD {
        unsafe {
            (*completion).call((
                AUTH_CHALLENGE_PERFORM_DEFAULT_HANDLING,
                std::ptr::null_mut(),
            ));
        }
        return;
    }

    let server_trust: *const c_void = unsafe { msg_send![&*protection_space, serverTrust] };
    let trusted = !server_trust.is_null()
        && unsafe { SecTrustEvaluateWithError(server_trust, std::ptr::null_mut()) };
    if server_trust.is_null() || trusted {
        unsafe {
            (*completion).call((
                AUTH_CHALLENGE_PERFORM_DEFAULT_HANDLING,
                std::ptr::null_mut(),
            ));
        }
        return;
    }

    let host: Retained<NSString> = unsafe { msg_send![&*protection_space, host] };
    let port: isize = unsafe { msg_send![&*protection_space, port] };
    let host = host.to_string();
    let port = u16::try_from(port).unwrap_or(443);
    let url = if port == 443 {
        format!("https://{host}/")
    } else {
        format!("https://{host}:{port}/")
    };
    let native_label = unsafe { native_label_for_webview(webview) };
    let context = webview_contexts().lock().ok().and_then(|contexts| {
        native_label
            .as_ref()
            .and_then(|label| contexts.get(label).cloned())
    });
    let (Some(native_label), Some(context)) = (native_label, context) else {
        log::warn!("Rejected invalid TLS certificate without a registered browser context: {url}");
        unsafe {
            (*completion).call((
                AUTH_CHALLENGE_PERFORM_DEFAULT_HANDLING,
                std::ptr::null_mut(),
            ));
        }
        return;
    };
    let certificate = EmbeddedBrowserInvalidTlsCertificate {
        native_label: native_label.clone(),
        url,
        host,
        port,
    };
    if let Ok(mut certificates) = invalid_tls_certificates().lock() {
        certificates.insert(native_label, certificate.clone());
    }
    if let Err(error) = context.app.emit(INVALID_TLS_CERTIFICATE_EVENT, certificate) {
        log::warn!("Failed to emit embedded browser invalid TLS warning: {error}");
    }

    let credential_class =
        AnyClass::get(c"NSURLCredential").expect("NSURLCredential must be available on macOS");
    let credential: Retained<AnyObject> =
        unsafe { msg_send![credential_class, credentialForTrust: server_trust] };
    unsafe {
        (*completion).call((
            AUTH_CHALLENGE_USE_CREDENTIAL,
            Retained::as_ptr(&credential).cast_mut(),
        ));
    }
}

fn challenge_delegate_class(superclass: &AnyClass) -> Result<&'static AnyClass, String> {
    static CLASS: OnceLock<Result<&'static AnyClass, String>> = OnceLock::new();
    CLASS
        .get_or_init(|| {
            let selector = sel!(webView:didReceiveAuthenticationChallenge:completionHandler:);
            if superclass.instance_method(selector).is_some() {
                return Err(format!(
                    "Navigation delegate {} already implements TLS authentication handling",
                    superclass.name().to_string_lossy()
                ));
            }
            let unique_id = std::ptr::addr_of!(WEBVIEW_NATIVE_LABEL_KEY) as usize;
            let class_name = format!("WegentEmbeddedBrowserNavigationDelegate_{unique_id:x}\0");
            let class_name = CStr::from_bytes_with_nul(class_name.as_bytes()).map_err(|error| {
                format!("Invalid embedded browser delegate class name: {error}")
            })?;
            let mut builder = ClassBuilder::new(class_name, superclass).ok_or_else(|| {
                "Failed to allocate embedded browser navigation delegate subclass".to_string()
            })?;
            unsafe {
                builder.add_method(
                    selector,
                    handle_authentication_challenge as unsafe extern "C-unwind" fn(_, _, _, _, _),
                );
            }
            Ok(builder.register())
        })
        .clone()
}

unsafe fn native_label_for_webview(webview: *mut AnyObject) -> Option<String> {
    if webview.is_null() {
        return None;
    }
    let label = unsafe {
        objc_getAssociatedObject(
            webview,
            std::ptr::addr_of!(WEBVIEW_NATIVE_LABEL_KEY).cast::<c_void>(),
        )
    };
    if label.is_null() {
        return None;
    }
    Some(unsafe { &*label.cast::<NSString>() }.to_string())
}

unsafe fn associate_native_label(webview: *mut AnyObject, native_label: Option<&str>) {
    let label = native_label.map(NSString::from_str);
    let value = label.as_ref().map_or(std::ptr::null_mut(), |label| {
        Retained::as_ptr(label).cast::<AnyObject>().cast_mut()
    });
    unsafe {
        objc_setAssociatedObject(
            webview,
            std::ptr::addr_of!(WEBVIEW_NATIVE_LABEL_KEY).cast::<c_void>(),
            value,
            OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
    }
}

unsafe fn install_challenge_handler(delegate: *mut AnyObject) -> Result<(), String> {
    if delegate.is_null() {
        return Err("Embedded browser navigation delegate is unavailable".to_string());
    }
    let delegate = unsafe { &*delegate };
    let current_class = delegate.class();
    let subclass = challenge_delegate_class(current_class)?;
    if !std::ptr::eq(current_class, subclass) {
        let previous_class = unsafe { AnyObject::set_class(delegate, subclass) };
        if !std::ptr::eq(previous_class, current_class) {
            return Err("Embedded browser navigation delegate class changed unexpectedly".into());
        }
    }
    Ok(())
}

unsafe fn restore_navigation_delegate_class(delegate: *mut AnyObject) {
    if delegate.is_null() {
        return;
    }
    let delegate = unsafe { &*delegate };
    let current_class = delegate.class();
    let Some(superclass) = current_class.superclass() else {
        return;
    };
    if current_class
        .name()
        .to_bytes()
        .starts_with(b"WegentEmbeddedBrowserNavigationDelegate_")
    {
        unsafe {
            AnyObject::set_class(delegate, superclass);
        }
    }
}

pub async fn register_invalid_tls_handler(
    webview: &Webview<Wry>,
    app: tauri::AppHandle,
    native_label: String,
) -> Result<(), String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let webview = platform_webview.inner().cast::<AnyObject>();
            let delegate: *mut AnyObject = msg_send![&*webview, navigationDelegate];
            let result = if delegate.is_null() {
                Err("Embedded browser navigation delegate is unavailable".to_string())
            } else {
                install_challenge_handler(delegate).and_then(|_| {
                    associate_native_label(webview, Some(&native_label));
                    webview_contexts()
                        .lock()
                        .map_err(|_| "Embedded browser TLS context lock poisoned".to_string())?
                        .insert(native_label, InvalidTlsWebviewContext { app });
                    let _: () = msg_send![
                        &*webview,
                        setNavigationDelegate: std::ptr::null::<AnyObject>()
                    ];
                    let _: () = msg_send![&*webview, setNavigationDelegate: delegate];
                    Ok(())
                })
            };
            let _ = sender.try_send(result);
        })
        .map_err(|error| format!("Failed to configure embedded browser TLS handling: {error}"))?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "Embedded browser TLS registration was cancelled".to_string())?
}

pub fn unregister_invalid_tls_handler(webview: &Webview<Wry>) {
    let _ = webview.with_webview(|platform_webview| unsafe {
        let webview = platform_webview.inner().cast::<AnyObject>();
        if let Some(native_label) = native_label_for_webview(webview) {
            if let Ok(mut contexts) = webview_contexts().lock() {
                contexts.remove(&native_label);
            }
            clear_invalid_tls_certificate(&native_label);
        }
        associate_native_label(webview, None);
        let delegate: *mut AnyObject = msg_send![&*webview, navigationDelegate];
        restore_navigation_delegate_class(delegate);
    });
}

pub fn invalid_tls_certificate(native_label: &str) -> Option<EmbeddedBrowserInvalidTlsCertificate> {
    invalid_tls_certificates()
        .lock()
        .ok()
        .and_then(|certificates| certificates.get(native_label).cloned())
}

pub fn clear_invalid_tls_certificate(native_label: &str) {
    if let Ok(mut certificates) = invalid_tls_certificates().lock() {
        certificates.remove(native_label);
    }
}

pub fn clear_invalid_tls_certificate_if_origin_changed(native_label: &str, loaded_url: &str) {
    let Some(certificate) = invalid_tls_certificate(native_label) else {
        return;
    };
    let Ok(certificate_url) = tauri::Url::parse(&certificate.url) else {
        clear_invalid_tls_certificate(native_label);
        return;
    };
    let Ok(loaded_url) = tauri::Url::parse(loaded_url) else {
        clear_invalid_tls_certificate(native_label);
        return;
    };
    let same_origin = certificate_url.scheme() == loaded_url.scheme()
        && certificate_url.host_str() == loaded_url.host_str()
        && certificate_url.port_or_known_default() == loaded_url.port_or_known_default();
    if !same_origin {
        clear_invalid_tls_certificate(native_label);
    }
}
