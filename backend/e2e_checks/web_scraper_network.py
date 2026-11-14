# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real Chromium checks against public-IP fixtures in the disposable CI namespace."""

import asyncio
import json
import os
import socket
import threading
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from crawl4ai import AsyncWebCrawler, BrowserConfig
from playwright.async_api import Browser, Error
from playwright.async_api import TimeoutError as BrowserTimeoutError
from playwright.async_api import async_playwright
from websockets.asyncio.server import ServerConnection, serve

from app.services.web_scraper.browser_security import (
    BrowserNavigation,
    configure_crawler_security,
    install_browser_guard,
)
from app.services.web_scraper.classifier import ScrapeResultClassifier
from app.services.web_scraper.models import ERROR_SSRF_BLOCKED
from app.services.web_scraper.policy import ScrapePolicy
from app.services.web_scraper.profiles import BrowserProfile
from app.services.web_scraper.proxy import ProxyMode, ProxyPlan
from app.services.web_scraper.quality import MarkdownQualityEvaluator
from app.services.web_scraper.security import (
    WebScraperSecurityError,
    WebScraperUrlGuard,
)
from app.services.web_scraper.strategies.crawl4ai_strategy import Crawl4AIScrapeStrategy


class WikiHandler(BaseHTTPRequestHandler):
    hits: Counter[str] = Counter()
    base_url: str
    websocket_url: str
    frame_url: str

    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        self.hits[self.path] += 1
        private = self.base_url
        loopback = private.replace(private.split("//")[1].split(":")[0], "127.0.0.1")
        if self.path in {"/hop-one", "/hop-two", "/asset-redirect", "/safe-hop"}:
            target = {
                "/safe-hop": private + "/wiki",
                "/hop-one": private + "/hop-two",
                "/hop-two": loopback + "/blocked-navigation",
                "/asset-redirect": loopback + "/blocked-resource",
            }[self.path]
            self.send_response(302)
            self.send_header("Location", target)
            self.end_headers()
            return
        body = self._body(private, loopback).encode()
        self.send_response(200)
        self.send_header(
            "Content-Type",
            (
                "application/javascript"
                if self.path.endswith(".js")
                else "text/html; charset=utf-8"
            ),
        )
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self, private: str, loopback: str) -> str:
        if self.path == "/shared-worker.js":
            return (
                self._socket_probe()
                + f"""
onconnect = event => {{
  const port = event.ports[0];
  port.postMessage(socketsBlocked() ? 'sockets_blocked' : 'sockets_escaped');
  fetch('{private}/shared-worker-resource').then(() => port.postMessage('http_allowed'));
  fetch('{loopback}/blocked-shared-worker').catch(() => port.postMessage('http_blocked'));
}};
"""
            )
        if self.path == "/native-service-worker.js":
            return f"fetch('{loopback}/blocked-service-worker'); fetch('{private}/service-worker-ran');"
        if self.path == "/js-redirect":
            return f'<script>location.replace("{private}/hop-one")</script>'
        if self.path == "/frame":
            probe = (
                self._socket_probe()
                + "postMessage(socketsBlocked() ? 'frame_sockets_blocked' : 'frame_sockets_escaped');"
            )
            return f"""<h1>Frame content</h1><img src="{private}/asset-redirect">
<script>
const childWorker = new Worker(URL.createObjectURL(new Blob([{json.dumps(probe)}], {{type: 'text/javascript'}})));
childWorker.onmessage = event => parent.postMessage(event.data, '*');
</script>"""
        if self.path != "/wiki":
            return (
                "<h1>Frame content</h1><p>Public page reference material.</p>"
                f'<img src="{private}/asset-redirect">'
            )
        blocked_ws = self.websocket_url.replace(
            private.split("//")[1].split(":")[0], "127.0.0.1"
        )
        return f"""<html><head><title>Public reference page</title>
<script>
window.addEventListener('message', event => {{
  if (event.origin === new URL('{self.frame_url}').origin && event.data === 'frame_sockets_blocked')
    document.body.dataset.frame_sockets_blocked = 'ok';
}});
</script></head><body>
<h1>Public reference page</h1>
<p>This public page has enough useful structured content to be indexed as a
knowledge document. Its normal public resources must remain available while
prohibited subrequests are stopped before reaching the target server.</p>
<iframe src="{self.frame_url}"></iframe>
<iframe src="{loopback}/blocked-frame"></iframe>
<img src="{private}/allowed-resource"><img src="{private}/asset-redirect">
<script>
const ws = new WebSocket('{self.websocket_url}');
ws.onmessage = () => {{ document.body.dataset.ws = 'ok'; ws.close(); }};
const blocked = new WebSocket('{blocked_ws}');
blocked.onerror = () => {{ document.body.dataset.blockedWs = 'ok'; }};
window.open('{loopback}/blocked-popup', '_blank');
navigator.serviceWorker.register('/worker.js').then(
  registration => {{
    document.body.dataset.worker = registration ? 'unexpected-registration' : 'blocked';
  }},
  () => {{ document.body.dataset.worker = 'blocked'; }}
);
const worker = new Worker(URL.createObjectURL(new Blob([{json.dumps(self._worker_script(private, loopback))}], {{type: 'text/javascript'}})));
worker.onmessage = (event) => {{
  document.body.dataset['worker_' + event.data] = 'ok';
}};
const shared = new SharedWorker('{private}/shared-worker.js');
shared.port.onmessage = event => {{ document.body.dataset['shared_' + event.data] = 'ok'; }};
shared.port.start();
</script></body></html>"""

    @staticmethod
    def _socket_probe() -> str:
        public = WikiHandler.websocket_url + "/worker-socket-public"
        private = public.replace(
            WikiHandler.base_url.split("//")[1].split(":")[0], "127.0.0.1"
        ).replace("worker-socket-public", "worker-socket-private")
        return (
            "const socketProbeUrls = "
            + json.dumps([public, private])
            + ";"
            + """
function socketsBlocked() {
  for (const name of ['WebSocket', 'WebSocketStream']) {
    let exposed = false;
    for (let owner = globalThis; owner; owner = Object.getPrototypeOf(owner)) {
      if (!Object.getOwnPropertyDescriptor(owner, name)) continue;
      exposed = true;
      for (const url of socketProbeUrls) {
        try { new owner[name](url); return false; }
        catch (error) { if (error.name !== 'SecurityError') return false; }
      }
    }
    if (name === 'WebSocket' && !exposed) return false;
  }
  return true;
}
"""
        )

    def _worker_script(self, private: str, loopback: str) -> str:
        nested = (
            self._socket_probe()
            + "postMessage(socketsBlocked() ? 'nested_sockets_blocked' : 'nested_sockets_escaped');"
        )
        return (
            self._socket_probe()
            + f"""
fetch('{private}/worker-resource').then(() => postMessage('allowed'));
fetch('{loopback}/blocked-worker').catch(() => postMessage('blocked'));
postMessage(socketsBlocked() ? 'sockets_blocked' : 'sockets_escaped');
const nested = new Worker(URL.createObjectURL(new Blob([{json.dumps(nested)}], {{type: 'text/javascript'}})));
nested.onmessage = event => postMessage(event.data);
"""
        )


async def check_browser(browser: Browser, guard: WebScraperUrlGuard) -> None:
    context = await browser.new_context(service_workers="block")
    installed = await install_browser_guard(context, guard)
    page = await context.new_page()
    navigation = BrowserNavigation()
    await installed.begin_navigation(context, page, navigation)
    await page.goto(WikiHandler.base_url + "/safe-hop", wait_until="load")
    assert page.url == WikiHandler.base_url + "/wiki"
    try:
        await page.wait_for_function(
            "document.body.dataset.ws === 'ok' && document.body.dataset.worker === 'blocked'"
            " && document.body.dataset.worker_allowed === 'ok'"
            " && document.body.dataset.worker_blocked === 'ok'"
            " && document.body.dataset.worker_sockets_blocked === 'ok'"
            " && document.body.dataset.worker_nested_sockets_blocked === 'ok'"
            " && document.body.dataset.shared_sockets_blocked === 'ok'"
            " && document.body.dataset.shared_http_allowed === 'ok'"
            " && document.body.dataset.shared_http_blocked === 'ok'"
            " && document.body.dataset.frame_sockets_blocked === 'ok'"
        )
    except BrowserTimeoutError as error:
        signals = await page.evaluate(
            "Object.fromEntries(['ws', 'worker', 'worker_allowed', 'worker_blocked',"
            " 'blockedWs', 'worker_sockets_blocked', 'worker_nested_sockets_blocked',"
            " 'shared_sockets_blocked', 'shared_http_allowed', 'shared_http_blocked', 'frame_sockets_blocked'"
            "].map(key => [key, document.body.dataset[key] ?? null]))"
        )
        hits = {
            path.split("?", 1)[0]: count for path, count in WikiHandler.hits.items()
        }
        raise AssertionError(
            f"Browser request checks did not settle: signals={signals!r} hits={hits!r}"
        ) from error
    navigation.raise_if_blocked()
    registrations = await page.evaluate(
        "async () => (await navigator.serviceWorker.getRegistrations()).length"
    )
    assert (
        registrations == 0
    ), f"Unexpected service-worker registrations: {registrations}"
    assert "Public reference page" in await page.content()
    assert WikiHandler.hits["/frame"] > 0
    assert WikiHandler.hits["/allowed-resource"] > 0
    assert WikiHandler.hits["/worker.js"] == 0
    assert WikiHandler.hits["/worker-resource"] > 0
    assert WikiHandler.hits["/shared-worker-resource"] > 0
    # Call the native prototype method instead of Playwright's instance shim.
    await asyncio.wait_for(
        page.evaluate(
            """async () => {
          try {
            await ServiceWorkerContainer.prototype.register.call(
              navigator.serviceWorker, '/native-service-worker.js'
            );
          } catch (_) {}
          const registrations = await navigator.serviceWorker.getRegistrations();
          if (registrations.some(registration => registration.active))
            throw new Error('A native service worker became active');
        }"""
        ),
        timeout=20,
    )
    assert WikiHandler.hits["/service-worker-ran"] == 0
    try:
        await page.goto(WikiHandler.base_url + "/hop-one")
    except Error:
        pass
    try:
        navigation.raise_if_blocked()
    except WebScraperSecurityError as error:
        assert error.error_code == ERROR_SSRF_BLOCKED
    else:
        raise AssertionError("Unsafe redirect was not reported as SSRF_BLOCKED")
    await context.close()


async def check_crawler(cdp_url: str, guard: WebScraperUrlGuard) -> None:
    crawler = AsyncWebCrawler(
        config=BrowserConfig(use_managed_browser=True, cdp_url=cdp_url)
    )
    configure_crawler_security(crawler, guard)
    await crawler.start()

    async def provider() -> AsyncWebCrawler:
        return crawler

    strategy = Crawl4AIScrapeStrategy(
        provider, ScrapeResultClassifier(), MarkdownQualityEvaluator()
    )
    try:
        for _ in range(2):
            result = await strategy.scrape(
                WikiHandler.base_url + "/safe-hop",
                ScrapePolicy(),
                BrowserProfile(name="desktop_chrome_cn"),
                ProxyPlan(mode=ProxyMode.NONE),
                guard,
            )
            assert result.success, result.error_message
            assert result.final_url == WikiHandler.base_url + "/wiki"
            assert "Public reference page" in result.markdown
        result = await strategy.scrape(
            WikiHandler.base_url + "/js-redirect",
            ScrapePolicy(),
            BrowserProfile(name="desktop_chrome_cn"),
            ProxyPlan(mode=ProxyMode.NONE),
            guard,
        )
        assert result.security_error_code == ERROR_SSRF_BLOCKED, result
    finally:
        await crawler.close()


async def main() -> None:
    ip = "11.255.255.254"
    guard = WebScraperUrlGuard()
    for target in ("http://127.0.0.1/", "http://10.1.2.3/", "http://169.254.169.254/"):
        try:
            guard.validate_initial_url(target)
        except WebScraperSecurityError as error:
            assert error.error_code == ERROR_SSRF_BLOCKED
        else:
            raise AssertionError(f"Unsafe initial target accepted: {target}")
    guard.validate_initial_url(f"http://{ip}/")
    server = ThreadingHTTPServer(("0.0.0.0", 0), WikiHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    WikiHandler.base_url = f"http://{ip}:{server.server_port}"
    WikiHandler.frame_url = f"http://11.255.255.253:{server.server_port}/frame"
    websocket_peers: list[str] = []
    websocket_paths: list[str] = []

    async def echo(websocket: ServerConnection) -> None:
        websocket_peers.append(websocket.remote_address[0])
        assert websocket.request is not None
        websocket_paths.append(websocket.request.path)
        await websocket.send("ok")

    try:
        async with serve(echo, "0.0.0.0", 0) as websocket_server:
            ws_port = websocket_server.sockets[0].getsockname()[1]
            WikiHandler.websocket_url = f"ws://{ip}:{ws_port}"
            with socket.socket() as cdp_socket:
                cdp_socket.bind(("127.0.0.1", 0))
                cdp_port = cdp_socket.getsockname()[1]
            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch(
                    executable_path=os.environ["E2E_CHROMIUM_EXECUTABLE"],
                    headless=True,
                    args=[
                        "--no-sandbox",
                        f"--remote-debugging-port={cdp_port}",
                        "--unsafely-treat-insecure-origin-as-secure="
                        + WikiHandler.base_url,
                    ],
                )
                try:
                    await check_browser(browser, guard)
                    await check_crawler(f"http://127.0.0.1:{cdp_port}", guard)
                finally:
                    await browser.close()
        assert not [
            path for path in WikiHandler.hits if path.startswith("/blocked")
        ], WikiHandler.hits
        assert websocket_peers and "127.0.0.1" not in websocket_peers, websocket_peers
        assert not any(
            path.startswith("/worker-socket-") for path in websocket_paths
        ), websocket_paths
        print("Browser and Crawl4AI request policy checks passed")
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    asyncio.run(main())
