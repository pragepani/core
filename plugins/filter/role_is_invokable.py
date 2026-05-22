"""Filter: True when a role's category (per `roles/categories.yml`) is
declared `invokable: true` at any level of its category path.

A role is "invokable" when at least one node along its category path
(top-level + sub-levels) is marked `invokable: true`. Roles whose entire
category chain is non-invokable are considered infrastructure and should
typically declare `required_by` so the deploy-time verifier can assert
coverage.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml

from utils import PROJECT_ROOT


@lru_cache(maxsize=8)
def _load_categories(categories_yml: str) -> dict:
    p = Path(categories_yml)
    if not p.is_file():
        return {}
    try:
        data = yaml.safe_load(p.read_text()) or {}
    except yaml.YAMLError:
        return {}
    return data.get("roles") or {} if isinstance(data, dict) else {}


def role_is_invokable(role_id: str, roles_dir: str | Path | None = None) -> bool:
    """True when any node along `role_id`'s category path has `invokable: true`."""
    if not role_id:
        return False
    base = Path(roles_dir) if roles_dir else (PROJECT_ROOT / "roles")
    tree = _load_categories(str(base / "categories.yml"))

    node = tree
    for seg in str(role_id).split("-"):
        if not seg or not isinstance(node, dict) or seg not in node:
            break
        node = node[seg]
        if isinstance(node, dict) and node.get("invokable") is True:
            return True
    return False


class FilterModule:
    def filters(self) -> dict:
        return {"role_is_invokable": role_is_invokable}
