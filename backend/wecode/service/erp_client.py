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
from typing import Optional

import httpx
from pydantic import BaseModel, ConfigDict, Field

from wecode.config.erp_config import erp_config

logger = logging.getLogger(__name__)


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

            try:
                # Token endpoint uses a short-lived client to avoid chicken-and-egg
                # problem with connection pooling before token is available.
                with httpx.Client(timeout=self.timeout) as client:
                    response = client.post(
                        f"{self.base_url}/api/oauth/client-token",
                        data={
                            "client_id": self.client_id,
                            "client_secret": self.client_secret,
                        },
                        headers={"Content-Type": "application/x-www-form-urlencoded"},
                    )
                    if response.status_code == 200:
                        data = response.json().get("data", {})
                        self._access_token = data.get("access_token")
                        expires_in = data.get("expires_in", 1800)
                        self._token_expires_at = time.time() + expires_in
                        logger.info("ERP access token refreshed")
                        return self._access_token
                    logger.error(
                        f"ERP token request failed: "
                        f"{response.status_code}: {response.text}"
                    )
                    return None
            except httpx.RequestError as e:
                logger.error(f"ERP token request error: {e}")
                return None

    @property
    def _http_client(self) -> httpx.Client:
        """Get or create a thread-local reusable HTTP client."""
        client = getattr(self._local, "client", None)
        if client is None or client.is_closed:
            client = httpx.Client(timeout=self.timeout)
            self._local.client = client
        return client

    def _get_headers(self) -> dict:
        """Get common request headers with Bearer token."""
        headers = {"Content-Type": "application/json"}
        token = self._ensure_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def _search(self, keyword: str) -> Optional[dict]:
        """Shared GET /api/open/search request used by department/employee search."""
        if not self.base_url or not keyword:
            return None
        try:
            response = self._http_client.get(
                f"{self.base_url}/api/open/search",
                params={"keyword": keyword},
                headers=self._get_headers(),
            )
            if response.status_code == 200:
                data = response.json().get("data", {}) or {}
                return data if isinstance(data, dict) else {}
            logger.error(f"ERP search error: {response.status_code}: {response.text}")
        except httpx.RequestError as e:
            logger.error(f"ERP search request failed: {e}")
        return None

    def batch_check_membership(
        self, ssn: str, department_ids: list[str]
    ) -> dict[str, bool]:
        """Check which departments a user belongs to.

        Args:
            ssn: Employee SSN (工号) to check
            department_ids: List of department IDs to check against (max 50)

        Returns:
            Dict mapping department_id to boolean membership status
        """
        if not self.base_url or not department_ids or not ssn:
            return {}

        # Split into chunks of 50 to respect API limit
        results: dict[str, bool] = {}
        failed_chunks: list[list[str]] = []
        client = self._http_client
        for i in range(0, len(department_ids), 50):
            chunk = department_ids[i : i + 50]
            try:
                response = client.post(
                    f"{self.base_url}/api/open/batch-check-membership",
                    json={"ssn": ssn, "department_ids": chunk},
                    headers=self._get_headers(),
                )
                if response.status_code == 200:
                    resp_data = response.json().get("data", {})
                    for item in resp_data.get("results", []):
                        raw_dept_id = item.get("department_id")
                        if raw_dept_id is not None:
                            # Ensure consistent string keys so they match
                            # entity_id strings stored in the database.
                            dept_id = str(raw_dept_id)
                            results[dept_id] = item.get("is_member", False)
                else:
                    logger.error(
                        f"ERP batch_check_membership error: "
                        f"{response.status_code}: {response.text}"
                    )
                    failed_chunks.append(chunk)
            except httpx.RequestError as e:
                logger.error(
                    f"ERP batch_check_membership chunk failed: {e}, "
                    f"chunk_size={len(chunk)}"
                )
                failed_chunks.append(chunk)

        if failed_chunks:
            affected = sum(len(c) for c in failed_chunks)
            logger.warning(
                f"ERP membership check incomplete: "
                f"{len(failed_chunks)} chunk(s) failed, "
                f"affecting {affected} department(s)"
            )

        return results

    def search_departments(self, keyword: str) -> list[DepartmentInfo]:
        """Search departments by keyword.

        Args:
            keyword: Search keyword (department name or related text)

        Returns:
            List of department info objects with id, name, label, etc.
        """
        data = self._search(keyword) or {}
        return [DepartmentInfo.model_validate(d) for d in data.get("departments", [])]

    def search_hidden_department_ids(self) -> Optional[set[str]]:
        """Return department IDs marked as hidden by the ERP T2 search."""
        data = self._search("T2")
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
        data = self._search(keyword) or {}
        employees = data.get("employees", [])
        if not employees:
            return None

        keyword_lower = keyword.lower() if keyword else ""
        for emp in employees:
            info = EmployeeInfo.model_validate(emp)
            if keyword_lower and (
                (info.ssn and info.ssn.lower() == keyword_lower)
                or (info.name and info.name.lower() == keyword_lower)
                or (info.email and info.email.lower() == keyword_lower)
            ):
                return info
        return EmployeeInfo.model_validate(employees[0])

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
        departments = self.search_departments(dept_id_str)
        for dept in departments:
            if dept.id == dept_id_str:
                return dept.name or dept.label

        logger.warning(f"ERP department name not found for id={dept_id_str}")
        return None


erp_client = ErpClient()
