"""Notte cloud browser provider — plugin form.

Config keys this provider responds to::

    browser:
      cloud_provider: "notte"

Auth env vars::

    NOTTE_API_KEY=...              # https://console.notte.cc

Optional knobs::

    NOTTE_API_URL=...              # default https://api.notte.cc
    NOTTE_PROXIES=true             # true/false or country code (e.g. us)
    NOTTE_MAX_DURATION_MINUTES=15
    NOTTE_IDLE_TIMEOUT_MINUTES=3
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Dict, Optional

import requests

from agent.browser_provider import BrowserProvider

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "https://api.notte.cc"


def _truthy(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _parse_proxies(value: str) -> bool | str:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return normalized


def _redact_secrets(text: str, *secrets: str) -> str:
    redacted = text
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    redacted = re.sub(r"sk-notte-[A-Za-z0-9_-]+", "[REDACTED]", redacted)
    return re.sub(r"notte_[A-Za-z0-9_-]+", "[REDACTED]", redacted)


def _error_body(response: requests.Response, *secrets: str) -> str:
    text = response.text
    stripped = text.strip().lower()
    if stripped.startswith("<!doctype") or stripped.startswith("<html"):
        return response.reason or "HTML error response"
    return _redact_secrets(text, *secrets)


class NotteBrowserProvider(BrowserProvider):
    """Notte (https://notte.cc) cloud browser backend."""

    @property
    def name(self) -> str:
        return "notte"

    @property
    def display_name(self) -> str:
        return "Notte"

    def is_available(self) -> bool:
        return self._get_config_or_none() is not None

    # ------------------------------------------------------------------
    # Config resolution
    # ------------------------------------------------------------------

    def _get_config_or_none(self) -> Optional[Dict[str, Any]]:
        api_key = os.environ.get("NOTTE_API_KEY")
        if not api_key:
            return None
        return {
            "api_key": api_key,
            "base_url": os.environ.get("NOTTE_API_URL", _DEFAULT_BASE_URL).rstrip("/"),
        }

    def _get_config(self) -> Dict[str, Any]:
        config = self._get_config_or_none()
        if config is None:
            raise ValueError("Notte requires a NOTTE_API_KEY environment variable.")
        return config

    # ------------------------------------------------------------------
    # Session lifecycle
    # ------------------------------------------------------------------

    def _headers(self, config: Dict[str, Any]) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {config['api_key']}",
            "Content-Type": "application/json",
        }

    def _session_payload(self) -> Dict[str, object]:
        payload: Dict[str, object] = {}

        proxies = os.environ.get("NOTTE_PROXIES")
        if proxies is not None and proxies.strip():
            payload["proxies"] = _parse_proxies(proxies)

        for env_key, request_key in (
            ("NOTTE_MAX_DURATION_MINUTES", "max_duration_minutes"),
            ("NOTTE_IDLE_TIMEOUT_MINUTES", "idle_timeout_minutes"),
        ):
            value = os.environ.get(env_key)
            if not value or not value.strip():
                continue
            try:
                parsed = int(value)
            except ValueError:
                logger.warning("Invalid %s value: %s", env_key, value)
                continue
            if parsed > 0:
                payload[request_key] = parsed

        return payload

    def create_session(self, task_id: str) -> Dict[str, object]:
        config = self._get_config()
        payload = self._session_payload()

        try:
            response = requests.post(
                f"{config['base_url']}/sessions/start",
                headers=self._headers(config),
                json=payload,
                timeout=30,
            )
        except requests.RequestException as exc:
            message = _redact_secrets(str(exc), config["api_key"])
            raise RuntimeError(f"Notte API connection failed: {message}") from exc

        if not response.ok:
            raise RuntimeError(
                f"Failed to start Notte session: "
                f"{response.status_code} {_error_body(response, config['api_key'])}"
            )

        session_data = response.json()
        session_id = session_data.get("session_id")
        cdp_url = session_data.get("cdp_url")
        if not session_id:
            raise RuntimeError("Invalid Notte session response: missing session_id")
        if not cdp_url:
            raise RuntimeError("Invalid Notte session response: missing cdp_url")

        features = {
            "notte": True,
            "proxies": payload.get("proxies", False),
            "max_duration_minutes": payload.get("max_duration_minutes"),
            "idle_timeout_minutes": payload.get("idle_timeout_minutes"),
        }

        logger.info("Created Notte session %s", session_id)
        return {
            "session_name": session_id,
            "bb_session_id": session_id,
            "cdp_url": cdp_url,
            "features": features,
        }

    def close_session(self, session_id: str) -> bool:
        try:
            config = self._get_config()
        except ValueError:
            logger.warning("Cannot close Notte session %s - missing credentials", session_id)
            return False

        try:
            response = requests.delete(
                f"{config['base_url']}/sessions/{session_id}/stop",
                headers={"Authorization": f"Bearer {config['api_key']}"},
                timeout=10,
            )
            if response.status_code in {200, 201, 202, 204}:
                logger.debug("Successfully closed Notte session %s", session_id)
                return True
            logger.warning(
                "Failed to close Notte session %s: HTTP %s - %s",
                session_id,
                response.status_code,
                _error_body(response, config["api_key"])[:200],
            )
            return False
        except Exception as e:
            message = _redact_secrets(str(e), config["api_key"])
            logger.error("Exception closing Notte session %s: %s", session_id, message)
            return False

    def emergency_cleanup(self, session_id: str) -> None:
        config = self._get_config_or_none()
        if config is None:
            logger.warning(
                "Cannot emergency-cleanup Notte session %s - missing credentials",
                session_id,
            )
            return
        try:
            requests.delete(
                f"{config['base_url']}/sessions/{session_id}/stop",
                headers={"Authorization": f"Bearer {config['api_key']}"},
                timeout=5,
            )
        except Exception as e:
            message = _redact_secrets(str(e), config["api_key"])
            logger.debug(
                "Emergency cleanup failed for Notte session %s: %s",
                session_id,
                message,
            )

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "Notte",
            "badge": "paid",
            "tag": "Cloud browser with CDP access",
            "env_vars": [
                {
                    "key": "NOTTE_API_KEY",
                    "prompt": "Notte API key",
                    "url": "https://console.notte.cc",
                },
            ],
            "post_setup": "agent_browser",
        }
