use std::time::Duration;

use gtk::prelude::*;
use tauri::{LogicalPosition, LogicalSize, Webview, Wry};

const HOST_NAME: &str = "wework-embedded-browser-host";

fn find_host(container: &gtk::Box) -> Option<gtk::Fixed> {
    container.children().into_iter().find_map(|child| {
        let overlay = child.downcast::<gtk::Overlay>().ok()?;
        overlay.children().into_iter().find_map(|overlay_child| {
            if overlay_child.widget_name() != HOST_NAME {
                return None;
            }
            overlay_child.downcast::<gtk::Fixed>().ok()
        })
    })
}

fn create_host(
    container: &gtk::Box,
    embedded_webview: &webkit2gtk::WebView,
) -> Result<gtk::Fixed, String> {
    let embedded_widget = embedded_webview.clone().upcast::<gtk::Widget>();
    let (main_webview_index, main_webview) = container
        .children()
        .into_iter()
        .enumerate()
        .find_map(|(index, child)| {
            if child == embedded_widget {
                return None;
            }
            child
                .downcast::<webkit2gtk::WebView>()
                .ok()
                .map(|webview| (index, webview))
        })
        .ok_or_else(|| "Main webview was not found in the GTK window container".to_string())?;

    container.remove(&main_webview);

    let overlay = gtk::Overlay::new();
    overlay.set_hexpand(true);
    overlay.set_vexpand(true);
    overlay.add(&main_webview);

    let host = gtk::Fixed::new();
    host.set_widget_name(HOST_NAME);
    host.set_hexpand(true);
    host.set_vexpand(true);
    host.set_halign(gtk::Align::Fill);
    host.set_valign(gtk::Align::Fill);
    overlay.add_overlay(&host);

    container.pack_start(&overlay, true, true, 0);
    container.reorder_child(&overlay, main_webview_index as i32);
    main_webview.show();
    host.show();
    overlay.show();

    Ok(host)
}

fn place_webview(
    embedded_webview: webkit2gtk::WebView,
    position: LogicalPosition<f64>,
    size: LogicalSize<f64>,
) -> Result<(), String> {
    let host = match embedded_webview
        .parent()
        .and_then(|parent| parent.downcast::<gtk::Fixed>().ok())
    {
        Some(host) => host,
        None => {
            let container = embedded_webview
                .parent()
                .and_then(|parent| parent.downcast::<gtk::Box>().ok())
                .ok_or_else(|| {
                    "Embedded browser webview is not attached to the GTK window container"
                        .to_string()
                })?;
            let host = find_host(&container)
                .map(Ok)
                .unwrap_or_else(|| create_host(&container, &embedded_webview))?;
            container.remove(&embedded_webview);
            host.put(&embedded_webview, 0, 0);
            host
        }
    };

    embedded_webview.set_size_request(size.width.round() as i32, size.height.round() as i32);
    host.move_(
        &embedded_webview,
        position.x.round() as i32,
        position.y.round() as i32,
    );
    Ok(())
}

pub fn apply_bounds(
    webview: &Webview<Wry>,
    position: LogicalPosition<f64>,
    size: LogicalSize<f64>,
) -> Result<(), String> {
    // Tauri packs Linux child webviews into the main GtkBox, so their requested
    // overlay bounds are ignored and they can collapse the app webview. Move
    // them into an absolute overlay host before exposing them to the frontend.
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let _ = sender.send(place_webview(platform_webview.inner(), position, size));
        })
        .map_err(|error| format!("Failed to access embedded browser webview: {error}"))?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Timed out positioning embedded browser webview: {error}"))?
}
