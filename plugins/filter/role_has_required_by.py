"""Filter: True when a role's `meta/services.yml` declares a non-empty
`required_by` (either `categories` or `roles`) on at least one entity."""

from __future__ import annotations

from pathlib import Path

import yaml

from utils import PROJECT_ROOT


def role_has_required_by(role_id: str, roles_dir: str | Path | None = None) -> bool:
    """True if any entity in `roles/<role_id>/meta/services.yml` declares
    `required_by.categories` or `required_by.roles` (non-empty)."""
    if not role_id:
        return False
    base = Path(roles_dir) if roles_dir else (PROJECT_ROOT / "roles")
    services_yml = base / str(role_id) / "meta" / "services.yml"
    if not services_yml.is_file():
        return False
    try:
        data = yaml.safe_load(services_yml.read_text()) or {}
    except yaml.YAMLError:
        return False
    if not isinstance(data, dict):
        return False
    for entry in data.values():
        if not isinstance(entry, dict):
            continue
        rb = entry.get("required_by")
        if not isinstance(rb, dict):
            continue
        if rb.get("categories") or rb.get("roles"):
            return True
    return False


class FilterModule:
    def filters(self) -> dict:
        return {"role_has_required_by": role_has_required_by}
