"""Operation-scoped cleanup for Elasticsearch clients and vector stores."""

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

logger = logging.getLogger(__name__)


@contextmanager
def managed_es_client(client: Any) -> Iterator[Any]:
    """Close an ES client/store without replacing an operation failure."""
    failed = False
    try:
        yield client
    except BaseException:
        failed = True
        raise
    finally:
        try:
            client.close()
        except BaseException as error:
            logger.error(
                "Elasticsearch client cleanup failed: client_type=%s error_type=%s",
                type(client).__name__,
                type(error).__name__,
            )
            if not failed:
                raise
