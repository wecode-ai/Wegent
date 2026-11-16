"""Regression coverage for real Elasticsearch transport ownership."""

import asyncio
import gc
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from elastic_transport import AiohttpHttpNode
from elasticsearch import AsyncElasticsearch, Elasticsearch
from llama_index.core.embeddings import MockEmbedding
from llama_index.core.schema import TextNode

import knowledge_engine.storage.elasticsearch_backend as backend_module
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend


def raise_failure(error: BaseException, *args, **kwargs) -> None:
    raise error


@pytest.fixture
def es_server():
    """Simulate only the external HTTP service; retain the real SDK transports."""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            self.respond({"version": {"number": "8.19.0"}})

        def do_HEAD(self):
            self.respond({})

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.respond({"hits": {"total": {"value": 0}, "hits": []}})

        def respond(self, payload):
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("X-Elastic-Product", "Elasticsearch")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
    )
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()
    thread.join()


@pytest.fixture
def tracked_clients(monkeypatch):
    """Record real clients, including the upstream temporary sync client."""
    import llama_index.vector_stores.elasticsearch.utils as store_utils

    sync_clients, async_clients, sessions = [], [], []
    create_session = AiohttpHttpNode._create_aiohttp_session

    def track_session(node):
        create_session(node)
        sessions.append((node.session, node.session.connector))

    monkeypatch.setattr(AiohttpHttpNode, "_create_aiohttp_session", track_session)

    def sync_client(*args, **kwargs):
        client = Elasticsearch(*args, **kwargs)
        sync_clients.append(client)
        return client

    def async_client(*args, **kwargs):
        client = AsyncElasticsearch(*args, **kwargs)
        async_clients.append(client)
        return client

    monkeypatch.setattr(backend_module, "Elasticsearch", sync_client)
    monkeypatch.setattr(
        backend_module, "AsyncElasticsearch", async_client, raising=False
    )
    monkeypatch.setattr(store_utils, "Elasticsearch", sync_client)
    monkeypatch.setattr(store_utils, "AsyncElasticsearch", async_client)
    return sync_clients, async_clients, sessions


def assert_transports_closed(clients):
    sync_clients, async_clients, sessions = clients
    for session, connector in sessions:
        assert session.closed, "aiohttp session remains open"
        assert connector.closed, "aiohttp connector remains open"
    assert sync_clients
    for client in async_clients:
        for node in client.transport.node_pool.all():
            assert (
                node.session is None or node.session.closed
            ), "aiohttp session remains open"
    for client in sync_clients:
        for node in client.transport.node_pool.all():
            assert node.pool.pool is None, "Synchronous connection pool remains open"


def exercise_operation(
    url, clients, operation, fail, monkeypatch, failure_type=ValueError
):
    """Run and clean up on the same event loop, even when regression asserts fail."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    backend = ElasticsearchBackend({"url": url})
    failure = failure_type("operation failed")

    def store_io(store):
        loop.run_until_complete(store.client.info())
        if fail:
            raise failure
        return []

    try:
        if operation == "retrieve":
            if fail:
                monkeypatch.setattr(
                    backend, "_process_query_results", partial(raise_failure, failure)
                )
            call = lambda: backend.retrieve(
                "kb", "test", None, {"retrieval_mode": "keyword"}
            )
        else:
            from llama_index.vector_stores.elasticsearch import ElasticsearchStore

            monkeypatch.setattr(
                ElasticsearchStore, "get_nodes", lambda store, **kw: store_io(store)
            )
            monkeypatch.setattr(
                ElasticsearchStore, "delete_nodes", lambda store, **kw: store_io(store)
            )
            if operation == "index":

                def index(nodes, *, storage_context, **kwargs):
                    store_io(storage_context.vector_store)

                monkeypatch.setattr(backend_module, "VectorStoreIndex", index)
                call = lambda: backend.index_with_metadata(
                    [],
                    ChunkMetadata("kb", "doc", "test", "2026-11-13"),
                    MockEmbedding(embed_dim=3),
                )
            elif operation == "delete":
                monkeypatch.setattr(backend, "delete_parent_nodes", lambda *a, **kw: 0)
                call = lambda: backend.delete_document("kb", "doc")
            else:
                call = lambda: backend.get_document("kb", "doc")
        if fail or operation == "get":
            with pytest.raises(type(failure) if fail else ValueError) as caught:
                call()
            if fail:
                assert caught.value is failure
        else:
            call()
        assert_transports_closed(clients)
    finally:
        for client in clients[0]:
            client.close()
        for client in clients[1]:
            loop.run_until_complete(client.close())
        loop.close()
        asyncio.set_event_loop(None)


@pytest.mark.parametrize("operation", ["retrieve", "index", "delete", "get"])
@pytest.mark.parametrize("fail", [False, True])
def test_vector_store_transports_closed(
    es_server, tracked_clients, monkeypatch, operation, fail
):
    exercise_operation(es_server, tracked_clients, operation, fail, monkeypatch)


def test_query_closes_transports_in_worker_thread(
    es_server, tracked_clients, monkeypatch, caplog
):
    with ThreadPoolExecutor(max_workers=1) as executor:
        for _ in range(3):
            executor.submit(
                exercise_operation,
                es_server,
                tracked_clients,
                "retrieve",
                False,
                monkeypatch,
            ).result()
    gc.collect()
    assert "Unclosed" not in caplog.text


def test_cancelled_query_closes_transports(es_server, tracked_clients, monkeypatch):
    exercise_operation(
        es_server,
        tracked_clients,
        "retrieve",
        True,
        monkeypatch,
        asyncio.CancelledError,
    )


@pytest.mark.parametrize(
    "operation",
    [
        "delete_document",
        "delete_knowledge",
        "drop_knowledge_index",
        "delete_parent_nodes",
        "list_documents",
        "get_all_chunks",
        "get_parent_nodes",
        "save_parent_nodes",
        "test_connection",
    ],
)
@pytest.mark.parametrize("fail", [False, True])
def test_native_clients_close_on_early_return_and_failure(
    es_server,
    tracked_clients,
    monkeypatch,
    operation,
    fail,
):
    backend = ElasticsearchBackend({"url": es_server})
    clients = tracked_clients[0]
    original = backend_module.Elasticsearch
    failure = ValueError("native operation failed")

    def create_client(*args, **kwargs):
        client = original(*args, **kwargs)
        if fail:
            monkeypatch.setattr(
                client.indices, "exists", partial(raise_failure, failure)
            )
            monkeypatch.setattr(client, "ping", partial(raise_failure, failure))
        else:
            monkeypatch.setattr(client.indices, "exists", lambda **kw: False)
        return client

    monkeypatch.setattr(backend_module, "Elasticsearch", create_client)
    calls = {
        "delete_document": lambda: backend.delete_document("kb", "doc"),
        "delete_knowledge": lambda: backend.delete_knowledge("kb"),
        "drop_knowledge_index": lambda: backend.drop_knowledge_index("kb"),
        "delete_parent_nodes": lambda: backend.delete_parent_nodes("kb", "doc"),
        "list_documents": lambda: backend.list_documents("kb"),
        "get_all_chunks": lambda: backend.get_all_chunks("kb"),
        "get_parent_nodes": lambda: backend.get_parent_nodes("kb", ["node"]),
        "save_parent_nodes": lambda: backend.save_parent_nodes(
            "kb", [TextNode(text="parent")]
        ),
        "test_connection": backend.test_connection,
    }
    monkeypatch.setattr(backend_module.helpers, "bulk", lambda *a, **kw: None)
    try:
        if fail and operation not in {"get_all_chunks", "test_connection"}:
            with pytest.raises(ValueError) as caught:
                calls[operation]()
            assert caught.value is failure
        else:
            calls[operation]()
        assert_transports_closed(tracked_clients)
    finally:
        for client in clients:
            client.close()


@pytest.mark.parametrize("operation_fails", [False, True])
def test_cleanup_failure_is_visible_and_preserves_primary_error(
    es_server,
    tracked_clients,
    monkeypatch,
    caplog,
    operation_fails,
):
    backend = ElasticsearchBackend({"url": es_server})
    original = backend_module.Elasticsearch
    primary = ValueError("operation failure")
    cleanup = RuntimeError("private-cleanup-details")

    def create_client(*args, **kwargs):
        client = original(*args, **kwargs)
        close = client.close

        def fail_close():
            close()
            raise cleanup

        monkeypatch.setattr(client, "close", fail_close)
        if operation_fails:
            monkeypatch.setattr(
                client.indices, "exists", partial(raise_failure, primary)
            )
        else:
            monkeypatch.setattr(client.indices, "exists", lambda **kw: False)
        return client

    monkeypatch.setattr(backend_module, "Elasticsearch", create_client)
    with pytest.raises((ValueError, RuntimeError)) as caught:
        backend.list_documents("kb")
    assert caught.value is (primary if operation_fails else cleanup)
    assert "cleanup failed" in caplog.text
    assert "RuntimeError" in caplog.text
    assert "private-cleanup-details" not in caplog.text
    assert_transports_closed(tracked_clients)


def test_store_constructor_failure_closes_created_clients(
    es_server,
    tracked_clients,
    monkeypatch,
):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    failure = ValueError("store construction failed")
    client_sessions = []

    def fail_store(*args, es_client, **kwargs):
        # Fail after acquiring a real async transport to exercise partial init.
        loop.run_until_complete(es_client.info())
        client_sessions.extend(
            node.session for node in es_client.transport.node_pool.all()
        )
        raise failure

    monkeypatch.setattr(backend_module, "ElasticsearchStore", fail_store)
    try:
        with pytest.raises(ValueError) as caught:
            ElasticsearchBackend({"url": es_server}).create_vector_store("index")
        assert caught.value is failure
        assert client_sessions and all(session.closed for session in client_sessions)
        assert_transports_closed(tracked_clients)
    finally:
        for client in tracked_clients[1]:
            loop.run_until_complete(client.close())
        loop.close()
        asyncio.set_event_loop(None)


def test_connection_check_failure_closes_temporary_client(
    es_server,
    tracked_clients,
    monkeypatch,
):
    failure = ConnectionError("connection check failed")
    monkeypatch.setattr(
        Elasticsearch, "info", lambda *args, **kwargs: raise_failure(failure)
    )
    try:
        with pytest.raises(ConnectionError) as caught:
            ElasticsearchBackend({"url": es_server}).create_vector_store("index")
        assert caught.value is failure
        assert not tracked_clients[1]
        assert_transports_closed(tracked_clients)
    finally:
        for client in tracked_clients[0]:
            client.close()


def test_query_from_async_caller_owns_worker_loop(es_server, tracked_clients):
    """Match QueryExecutor's to_thread boundary without preinstalling a loop."""

    def retrieve():
        asyncio.set_event_loop(None)
        try:
            backend = ElasticsearchBackend({"url": es_server})
            result = backend.retrieve("kb", "test", None, {"retrieval_mode": "keyword"})
            assert result == {"records": []}
            assert_transports_closed(tracked_clients)
        finally:
            loop = asyncio.get_event_loop()
            for client in tracked_clients[1]:
                loop.run_until_complete(client.close())
            loop.close()
            asyncio.set_event_loop(None)

    async def execute():
        await asyncio.to_thread(retrieve)

    asyncio.run(execute())
