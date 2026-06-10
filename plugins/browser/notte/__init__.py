"""Notte cloud browser plugin — bundled, auto-loaded."""

from __future__ import annotations

from plugins.browser.notte.provider import NotteBrowserProvider


def register(ctx) -> None:
    """Register the Notte provider with the plugin context."""
    ctx.register_browser_provider(NotteBrowserProvider())
