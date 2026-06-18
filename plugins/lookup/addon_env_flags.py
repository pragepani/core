from __future__ import annotations

import re
from typing import Any

from ansible.errors import AnsibleError
from ansible.plugins.lookup import LookupBase

from utils.cache.applications import get_merged_applications
from utils.cache.base import _render_with_templar
from utils.roles.applications.config import get

ENV_SUFFIX = "_ADDON_ENABLED"
_TRUE_TOKENS = {"true", "1", "yes", "on", "t", "y"}


def env_key(addon_id: str) -> str:
    """Mirror addon-gating.js envKey(): upper-case, non-alphanumeric runs -> '_'."""
    return re.sub(r"[^A-Z0-9]+", "_", str(addon_id).upper()) + ENV_SUFFIX


def _is_enabled(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in _TRUE_TOKENS


class LookupModule(LookupBase):
    """
    lookup('addon_env_flags', application_id)

    Single source of truth for the per-addon enable flags consumed by the
    Playwright addon-gating helper (``tests/addon-gating.js`` ->
    ``skipUnlessAddonEnabled``). Replaces the error-prone per-template Jinja
    loop: it resolves the materialised ``addons`` mapping for ``application_id``
    and returns one ``<ADDON_ID>_ADDON_ENABLED=<true|false>`` line per declared
    addon (sorted by env key, newline-joined), where the env-key derivation
    matches addon-gating.js exactly.

    A flag is ``true`` only when the addon is both ``enabled`` AND
    ``required``. Optional addons (``required: false``) are intentionally
    skipped by the spec suite — they are a variant axis, not a guaranteed
    surface — so their gate flag is ``false`` even when enabled.
    """

    def run(self, terms, variables: dict[str, Any] | None = None, **kwargs):
        if not terms or len(terms) != 1:
            raise AnsibleError(
                "lookup('addon_env_flags', application_id) expects exactly one term."
            )

        application_id = terms[0]
        templar = getattr(self, "_templar", None)
        variables = variables or getattr(self._templar, "available_variables", {}) or {}

        applications = get_merged_applications(
            variables=variables,
            roles_dir=kwargs.get("roles_dir"),
            templar=templar,
        )
        addons = get(
            applications=applications,
            application_id=application_id,
            config_path="addons",
            strict=False,
            default={},
            skip_missing_app=True,
        )
        addons = _render_with_templar(
            addons,
            templar=templar,
            variables=variables,
            raw_applications=applications,
        )
        if not isinstance(addons, dict):
            addons = {}

        lines = []
        for addon_id in sorted(addons, key=env_key):
            spec = (
                addons.get(addon_id) if isinstance(addons.get(addon_id), dict) else {}
            )
            active = _is_enabled(spec.get("enabled", False)) and _is_enabled(
                spec.get("required", False)
            )
            lines.append(f"{env_key(addon_id)}={'true' if active else 'false'}")

        return ["\n".join(lines)]
