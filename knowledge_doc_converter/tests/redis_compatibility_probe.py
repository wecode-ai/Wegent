"""Exercise real worker, result backend and lock against an isolated Redis 5."""

import argparse
import os
from importlib.metadata import version
from uuid import uuid4


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--redis-url", required=True)
    args = parser.parse_args()
    # This URL must name a disposable test Redis, never a business broker.
    for name in ("CELERY_BROKER_URL", "CELERY_RESULT_BACKEND", "REDIS_URL"):
        os.environ[name] = args.redis_url
    os.environ["PROMETHEUS_ENABLED"] = "false"
    os.environ["LOG_FILE_ENABLED"] = "false"
    os.environ["MULTIMODAL_ENABLED"] = "false"
    os.environ["REDIS_PASSWORD"] = ""

    from celery.contrib.testing.worker import start_worker

    from knowledge_doc_converter.celery_app import celery_app
    from knowledge_doc_converter.services.lock_service import DistributedLock

    celery_app.conf.update(
        broker_connection_retry_on_startup=False,
        broker_connection_retry=False,
        broker_connection_timeout=3,
    )
    queue = "converter-compat-" + uuid4().hex

    @celery_app.task(name=queue)
    def verify_lock(value: str) -> str:
        lock = DistributedLock()
        try:
            assert lock.acquire(queue)
            assert not lock.acquire(queue)
            lock.extend(queue, 30)
            return value
        finally:
            lock.release(queue)
            lock.redis_client.close()

    print({name: version(name) for name in ("redis", "celery", "kombu")})
    published = False
    try:
        with start_worker(
            celery_app,
            pool="solo",
            concurrency=1,
            queues=[queue],
            perform_ping_check=False,
            shutdown_timeout=15,
        ):
            result = verify_lock.apply_async(args=[queue], queue=queue)
            published = True
            try:
                assert result.get(timeout=20) == queue
                assert result.state == "SUCCESS"
            finally:
                result.forget()
        print("PASS: broker consume, task completion, result backend, conversion lock")
    finally:
        if published:
            with celery_app.connection_for_write() as connection:
                connection.default_channel.queue_delete(queue)
        celery_app.close()


if __name__ == "__main__":
    main()
