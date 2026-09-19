# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
ERP OpenSearch API v2 client for department membership and search.

Provides integration with the internal ERP system via OAuth 2.0 Client Credentials:
- Search departments by keyword
- Check department membership in batch
"""

import logging
import threading
import time
from dataclasses import dataclass
from enum import Enum
from typing import Optional

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from wecode.config.erp_config import erp_config

logger = logging.getLogger(__name__)


class ErpRequestOutcome(str, Enum):
    SUCCESS = "success"
    HTTP_ERROR = "http_error"
    TIMEOUT = "timeout"
    REQUEST_ERROR = "request_error"
    INVALID_RESPONSE = "invalid_response"


class EmployeeSearchOutcome(str, Enum):
    FOUND = "found"
    NOT_FOUND = "not_found"
    REQUEST_FAILED = "request_failed"
    INVALID_RESPONSE = "invalid_response"


@dataclass(frozen=True)
class _ErpRequestResult:
    response: Optional[httpx.Response]
    outcome: ErpRequestOutcome


@dataclass(frozen=True)
class EmployeeSearchResult:
    outcome: EmployeeSearchOutcome
    employee: Optional["EmployeeInfo"] = None


class EmployeeInfo(BaseModel):
    """Employee information returned by ERP search API."""

    ssn: Optional[str] = None
    name: Optional[str] = None
    email: Optional[str] = None
    department: Optional[str] = None


class DepartmentInfo(BaseModel):
    """Department information returned by ERP search API."""

    model_config = ConfigDict(
        populate_by_name=True,
        coerce_numbers_to_str=True,
    )

    id: Optional[str] = Field(default=None, validation_alias="department_id")
    name: Optional[str] = None
    label: Optional[str] = None
    supervisor_name: Optional[str] = None
    employee_count: Optional[int] = None


class ErpClient:
    """Client for ERP OpenSearch API v2."""

    def __init__(self):
        self.base_url = erp_config.ERP_OPENSEARCH_BASE_URL.rstrip("/")
        self.client_id = erp_config.ERP_CLIENT_ID
        self.client_secret = erp_config.ERP_CLIENT_secret
        self.timeout = erp_config.ERP_API_TIMEOUT
        self._access_token: Optional[str] = None
        self._token_expires_at: float = 0.0
        self._local = threading.local()
        self._token_lock = threading.Lock()

    @staticmethod
    def _mask_query_value(value: str) -> str:
        if not value or len(value) <= 4:
            return "****"
        if "@" in value:
            local, domain = value.split("@", 1)
            prefix = local[:2] if len(local) > 2 else local[:1]
            return f"{prefix}****@{domain}"
        return f"{value[:2]}****{value[-2:]}"

    @classmethod
    def _safe_search_params(cls, keyword: str) -> dict[str, object]:
        if keyword == "T2":
            return {"keyword": keyword, "keyword_type": "system"}
        if "@" in keyword:
            keyword_type = "email"
        elif keyword.isdigit():
            keyword_type = "numeric_id"
        else:
            keyword_type = "text"
        return {
            "keyword": cls._mask_query_value(keyword),
            "keyword_type": keyword_type,
        }

    def _request(
        self,
        client: httpx.Client,
        *,
        operation: str,
        method: str,
        path: str,
        safe_params: dict[str, object],
        **request_kwargs,
    ) -> _ErpRequestResult:
        started_at = time.perf_counter()
        response: Optional[httpx.Response] = None
        outcome = ErpRequestOutcome.REQUEST_ERROR
        error_type: Optional[str] = None
        try:
            response = client.request(
                method,
                f"{self.base_url}{path}",
                timeout=self.timeout,
                **request_kwargs,
            )
            outcome = (
                ErpRequestOutcome.SUCCESS
                if response.is_success
                else ErpRequestOutcome.HTTP_ERROR
            )
        except httpx.TimeoutException as exc:
            outcome = ErpRequestOutcome.TIMEOUT
            error_type = type(exc).__name__
        except httpx.RequestError as exc:
            error_type = type(exc).__name__

        elapsed_ms = round((time.perf_counter() - started_at) * 1000)
        status_code = response.status_code if response is not None else None
        log = logger.info if outcome is ErpRequestOutcome.SUCCESS else logger.warning
        log(
            "ERP HTTP request completed: operation=%s method=%s path=%s "
            "outcome=%s status_code=%s elapsed_ms=%s query_params=%s "
            "error_type=%s",
            operation,
            method,
            path,
            outcome.value,
            status_code,
            elapsed_ms,
            safe_params,
            error_type,
        )
        return _ErpRequestResult(response, outcome)

    @staticmethod
    def _parse_response_data(
        response: httpx.Response, *, operation: str
    ) -> Optional[dict]:
        error_type: Optional[str] = None
        payload_type: Optional[str] = None
        try:
            payload = response.json()
            payload_type = type(payload).__name__
            if not isinstance(payload, dict):
                raise TypeError("response root must be an object")
            if "data" not in payload:
                raise TypeError("response data is required")
            data = payload["data"]
            payload_type = type(data).__name__
            if not isinstance(data, dict):
                raise TypeError("response data must be an object")
            return data
        except (TypeError, ValueError) as exc:
            error_type = type(exc).__name__

        logger.warning(
            "ERP response parse failed: operation=%s outcome=invalid_response "
            "status_code=%s payload_type=%s error_type=%s",
            operation,
            response.status_code,
            payload_type,
            error_type,
        )
        return None

    def _ensure_token(self) -> Optional[str]:
        """Get valid access token, refreshing if needed.

        Uses double-checked locking so concurrent callers do not all
        trigger a token refresh in parallel.
        """
        if self._access_token and time.time() < self._token_expires_at - 60:
            return self._access_token

        with self._token_lock:
            # Re-check inside the lock in case another thread refreshed
            # the token while we were waiting.
            if self._access_token and time.time() < self._token_expires_at - 60:
                return self._access_token

            if not self.client_id or not self.client_secret:
                logger.warning("ERP client credentials not configured")
                return None

            # Token endpoint uses a short-lived client to avoid chicken-and-egg
            # problem with connection pooling before token is available.
            with httpx.Client() as client:
                result = self._request(
                    client,
                    operation="oauth_token",
                    method="POST",
                    path="/api/oauth/client-token",
                    safe_params={
                        "client_id": self._mask_query_value(self.client_id),
                        "client_secret": "[REDACTED]",
                    },
                    data={
                        "client_id": self.client_id,
                        "client_secret": self.client_secret,
                    },
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
                response = result.response
                if result.outcome is ErpRequestOutcome.SUCCESS and response is not None:
                    data = self._parse_response_data(response, operation="oauth_token")
                    if data is None:
                        return None
                    self._access_token = data.get("access_token")
                    expires_in = data.get("expires_in", 1800)
                    self._token_expires_at = time.time() + expires_in
                    logger.info("ERP access token refreshed")
                    return self._access_token
                return None

    @property
    def _http_client(self) -> httpx.Client:
        """Get or create a thread-local reusable HTTP client."""
        client = getattr(self._local, "client", None)
        if client is None or client.is_closed:
            client = httpx.Client()
            self._local.client = client
        return client

    def _get_headers(self) -> dict:
        """Get common request headers with Bearer token."""
        headers = {"Content-Type": "application/json"}
        token = self._ensure_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def _search(
        self, keyword: str, *, operation: str = "search"
    ) -> tuple[Optional[dict], ErpRequestOutcome]:
        """Shared GET /api/open/search request used by department/employee search."""
        if not self.base_url or not keyword:
            return None, ErpRequestOutcome.REQUEST_ERROR
        result = self._request(
            self._http_client,
            operation=operation,
            method="GET",
            path="/api/open/search",
            safe_params=self._safe_search_params(keyword),
            params={"keyword": keyword},
            headers=self._get_headers(),
        )
        response = result.response
        if result.outcome is ErpRequestOutcome.SUCCESS and response is not None:
            data = self._parse_response_data(response, operation=operation)
            if data is None:
                return None, ErpRequestOutcome.INVALID_RESPONSE
            return data, result.outcome
        return None, result.outcome

    def _check_membership_chunk(
        self,
        client: httpx.Client,
        *,
        ssn: str,
        department_ids: list[str],
        chunk_index: int,
        chunk_count: int,
    ) -> Optional[dict[str, bool]]:
        result = self._request(
            client,
            operation="batch_check_membership",
            method="POST",
            path="/api/open/batch-check-membership",
            safe_params={
                "ssn": self._mask_query_value(ssn),
                "department_ids": department_ids[:10],
                "department_count": len(department_ids),
                "department_ids_truncated": len(department_ids) > 10,
                "chunk_index": chunk_index,
                "chunk_count": chunk_count,
            },
            json={"ssn": ssn, "department_ids": department_ids},
            headers=self._get_headers(),
        )
        response = result.response
        if result.outcome is not ErpRequestOutcome.SUCCESS or response is None:
            return None
        data = self._parse_response_data(response, operation="batch_check_membership")
        response_results = data.get("results") if data is not None else None
        if not isinstance(response_results, list):
            return None
        membership: dict[str, bool] = {}
        for item in response_results:
            if not isinstance(item, dict):
                return None
            department_id = item.get("department_id")
            if department_id is not None:
                membership[str(department_id)] = item.get("is_member", False)
        return membership

    def batch_check_membership(
        self, ssn: str, department_ids: list[str]
    ) -> dict[str, bool]:
        """Return membership results for department IDs in chunks of 50."""
        if not self.base_url or not department_ids or not ssn:
            return {}

        results: dict[str, bool] = {}
        failed_chunks: list[list[str]] = []
        client = self._http_client
        started_at = time.perf_counter()
        chunks = [department_ids[i : i + 50] for i in range(0, len(department_ids), 50)]
        for chunk_index, chunk in enumerate(chunks, start=1):
            chunk_result = self._check_membership_chunk(
                client,
                ssn=ssn,
                department_ids=chunk,
                chunk_index=chunk_index,
                chunk_count=len(chunks),
            )
            if chunk_result is None:
                failed_chunks.append(chunk)
            else:
                results.update(chunk_result)

        if failed_chunks:
            affected = sum(len(c) for c in failed_chunks)
            logger.warning(
                f"ERP membership check incomplete: "
                f"{len(failed_chunks)} chunk(s) failed, "
                f"affecting {affected} department(s)"
            )

        elapsed_ms = round((time.perf_counter() - started_at) * 1000)
        logger.info(
            "ERP membership check completed: chunk_count=%s failed_chunk_count=%s "
            "department_count=%s matched_count=%s elapsed_ms=%s outcome=%s",
            len(chunks),
            len(failed_chunks),
            len(department_ids),
            sum(1 for matched in results.values() if matched),
            elapsed_ms,
            "partial_failure" if failed_chunks else "success",
        )

        return results

    def search_departments(self, keyword: str) -> list[DepartmentInfo]:
        """Search departments by keyword.

        Args:
            keyword: Search keyword (department name or related text)

        Returns:
            List of department info objects with id, name, label, etc.
        """
        data, _ = self._search(keyword, operation="department_search")
        data = data or {}
        return [DepartmentInfo.model_validate(d) for d in data.get("departments", [])]

    def search_hidden_department_ids(self) -> Optional[set[str]]:
        """Return department IDs marked as hidden by the ERP T2 search."""
        data, _ = self._search("T2", operation="hidden_department_search")
        if data is None:
            return None

        department_ids: set[str] = set()
        for department in data.get("departments", []):
            info = DepartmentInfo.model_validate(department)
            if info.id:
                department_ids.add(str(info.id).strip())
        return department_ids

    def search_employee(self, keyword: str) -> Optional[EmployeeInfo]:
        """Search employee by keyword (username, email, or ssn).

        Prefers an exact case-insensitive match on ssn, name, or email; falls
        back to the first result if no exact match is found.

        Args:
            keyword: Search keyword, typically username, email, or email prefix

        Returns:
            Employee info object with ssn, name, email, department, or None if not found
        """
        return self.search_employee_result(keyword).employee

    def search_employee_result(self, keyword: str) -> EmployeeSearchResult:
        """Search an employee while preserving request failure semantics."""
        data, request_outcome = self._search(keyword, operation="employee_search")
        if request_outcome is ErpRequestOutcome.INVALID_RESPONSE:
            return EmployeeSearchResult(EmployeeSearchOutcome.INVALID_RESPONSE)
        if request_outcome is not ErpRequestOutcome.SUCCESS:
            return EmployeeSearchResult(EmployeeSearchOutcome.REQUEST_FAILED)
        if data is None:
            return EmployeeSearchResult(EmployeeSearchOutcome.INVALID_RESPONSE)
        if "employees" not in data or not isinstance(data["employees"], list):
            return EmployeeSearchResult(EmployeeSearchOutcome.INVALID_RESPONSE)
        employees = data["employees"]
        if not employees:
            return EmployeeSearchResult(EmployeeSearchOutcome.NOT_FOUND)

        if not all(isinstance(employee, dict) for employee in employees):
            return EmployeeSearchResult(EmployeeSearchOutcome.INVALID_RESPONSE)

        keyword_lower = keyword.lower() if keyword else ""
        try:
            parsed_employees = [EmployeeInfo.model_validate(emp) for emp in employees]
        except ValidationError:
            return EmployeeSearchResult(EmployeeSearchOutcome.INVALID_RESPONSE)

        for info in parsed_employees:
            if keyword_lower and (
                (info.ssn and info.ssn.lower() == keyword_lower)
                or (info.name and info.name.lower() == keyword_lower)
                or (info.email and info.email.lower() == keyword_lower)
            ):
                return EmployeeSearchResult(EmployeeSearchOutcome.FOUND, info)
        return EmployeeSearchResult(EmployeeSearchOutcome.FOUND, parsed_employees[0])

    def get_department_display_name(self, department_id: str) -> Optional[str]:
        """Get display name for a department by ID.

        Uses search API with the department_id as keyword.

        Args:
            department_id: Department ID to look up

        Returns:
            Department name string, or None if not found
        """
        if not department_id:
            return None

        dept_id_str = str(department_id)
        data, _ = self._search(dept_id_str, operation="department_display_name_search")
        departments = [
            DepartmentInfo.model_validate(department)
            for department in (data or {}).get("departments", [])
        ]
        for dept in departments:
            if dept.id == dept_id_str:
                return dept.name or dept.label

        logger.warning(f"ERP department name not found for id={dept_id_str}")
        return None


erp_client = ErpClient()
