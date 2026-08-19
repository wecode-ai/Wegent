use std::{cell::Cell, rc::Rc, time::Duration};

use gtk::prelude::*;
use tauri::{LogicalPosition, LogicalSize, Webview, Wry};
use webkit2gtk::WebViewExt;

const HOST_NAME: &str = "wework-embedded-browser-host";
const ALLOCATION_CONTROLLER_DATA: &str = "wework-embedded-browser-allocation-controller";

#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct AllocationTarget {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

struct AllocationController {
    target: Cell<AllocationTarget>,
    applying: Cell<bool>,
    idle_pending: Cell<bool>,
    requested_zoom: Cell<f64>,
}

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

    // The Tauri-created WebView expands by default. In a GtkFixed host that
    // makes the page viewport match the full host width instead of the bounds
    // requested by the device toolbar.
    embedded_webview.set_hexpand(false);
    embedded_webview.set_vexpand(false);
    embedded_webview.set_halign(gtk::Align::Start);
    embedded_webview.set_valign(gtk::Align::Start);
    let x = position.x.round() as i32;
    let y = position.y.round() as i32;
    let width = size.width.round() as i32;
    let height = size.height.round() as i32;
    embedded_webview.set_size_request(width, height);
    host.move_(&embedded_webview, x, y);
    let controller = allocation_controller(&host);
    controller.target.set(AllocationTarget {
        x,
        y,
        width,
        height,
    });
    apply_webview_allocation(&embedded_webview, x, y, width, height);
    apply_effective_zoom(&host, &embedded_webview, &controller);

    Ok(())
}

fn allocation_controller(host: &gtk::Fixed) -> Rc<AllocationController> {
    if let Some(controller) =
        unsafe { host.data::<Rc<AllocationController>>(ALLOCATION_CONTROLLER_DATA) }
            .map(|data| unsafe { data.as_ref().clone() })
    {
        return controller;
    }

    let controller = Rc::new(AllocationController {
        target: Cell::new(AllocationTarget::default()),
        applying: Cell::new(false),
        idle_pending: Cell::new(false),
        requested_zoom: Cell::new(1.0),
    });
    let callback_controller = controller.clone();
    host.connect_size_allocate(move |host, _| {
        enforce_webview_allocation(host, &callback_controller);
        if callback_controller.idle_pending.replace(true) {
            return;
        }
        let deferred_host = host.clone();
        let deferred_controller = callback_controller.clone();
        gtk::glib::idle_add_local_once(move || {
            deferred_controller.idle_pending.set(false);
            enforce_webview_allocation(&deferred_host, &deferred_controller);
        });
    });
    if let Some(webview) = host
        .children()
        .into_iter()
        .find_map(|child| child.downcast::<webkit2gtk::WebView>().ok())
    {
        let callback_controller = controller.clone();
        webview.connect_size_allocate(move |webview, _| {
            let Some(host) = webview
                .parent()
                .and_then(|parent| parent.downcast::<gtk::Fixed>().ok())
            else {
                return;
            };
            enforce_webview_allocation(&host, &callback_controller);
        });
    }
    unsafe { host.set_data(ALLOCATION_CONTROLLER_DATA, controller.clone()) };
    controller
}

fn enforce_webview_allocation(host: &gtk::Fixed, controller: &AllocationController) {
    let target = controller.target.get();
    if controller.applying.get() {
        return;
    }

    let Some(webview) = host
        .children()
        .into_iter()
        .find_map(|child| child.downcast::<webkit2gtk::WebView>().ok())
    else {
        return;
    };
    let allocation = webview.allocation();
    if allocation.x() == target.x
        && allocation.y() == target.y
        && allocation.width() == target.width
        && allocation.height() == target.height
    {
        return;
    }

    controller.applying.set(true);
    host.move_(&webview, target.x, target.y);
    apply_webview_allocation(&webview, target.x, target.y, target.width, target.height);
    apply_effective_zoom(host, &webview, controller);
    controller.applying.set(false);
}

fn apply_effective_zoom(
    host: &gtk::Fixed,
    webview: &webkit2gtk::WebView,
    controller: &AllocationController,
) {
    let target_width = controller.target.get().width.max(1) as f64;
    // WebKitGTK renders this Tauri child at the GtkFixed host width even when
    // GTK reports the temporary child allocation requested above. Use the host
    // width as the physical viewport so browser zoom produces the requested
    // CSS viewport rather than the host-sized 918px viewport seen in CI.
    let actual_width = host.allocation().width().max(1) as f64;
    let scale_factor = controller.requested_zoom.get() * actual_width / target_width;
    webview.set_zoom_level(scale_factor.max(0.01));
}

pub fn set_zoom(webview: &Webview<Wry>, scale_factor: f64) -> Result<(), String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let native_webview = platform_webview.inner();
            if let Some(host) = native_webview
                .parent()
                .and_then(|parent| parent.downcast::<gtk::Fixed>().ok())
            {
                let controller = allocation_controller(&host);
                controller.requested_zoom.set(scale_factor);
                apply_effective_zoom(&host, &native_webview, &controller);
            } else {
                native_webview.set_zoom_level(scale_factor);
            }
            let result: Result<(), String> = Ok(());
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Failed to access embedded browser webview: {error}"))?;
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|error| format!("Timed out setting embedded browser zoom: {error}"))?
}

fn apply_webview_allocation(
    embedded_webview: &webkit2gtk::WebView,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) {
    // GtkFixed normally allocates a child from its natural size. Apply the
    // requested allocation explicitly so WebKit reports the device viewport
    // instead of the host's full width through window.innerWidth.
    let allocation = gtk::Allocation::new(x, y, width, height);
    embedded_webview.set_allocation(&allocation);
    embedded_webview.size_allocate(&allocation);
    if let Some(window) = embedded_webview.window() {
        if window.window_type() == gtk::gdk::WindowType::Child {
            window.move_resize(x, y, width, height);
        }
    }
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
