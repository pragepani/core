"""Filter: True when a role's `meta/services.yml` contains a
`# nocheck: <check_id>` comment opting that role out of the named
lint check.

Comments may live anywhere in the file. Whitespace around the colon
and after the check id are tolerated. The check id is matched as a
whole word so `# nocheck: required-by` does NOT match
`required-by-coverage`.
"""

from __future__ import annotations

import re
from pathlib import Path

from utils import PROJECT_ROOT


def role_has_nocheck(
    role_id: str,
    check_id: str,
    roles_dir: str | Path | None = None,
) -> bool:
    """True if `roles/<role_id>/meta/services.yml` contains
    `# nocheck: <check_id>` (whole-word match)."""
    if not role_id or not check_id:
        return False
    base = Path(roles_dir) if roles_dir else (PROJECT_ROOT / "roles")
    services_yml = base / str(role_id) / "meta" / "services.yml"
    if not services_yml.is_file():
        return False
    pattern = re.compile(rf"#\s*nocheck:\s*{re.escape(check_id)}(?!\S)")
    try:
        return bool(pattern.search(services_yml.read_text()))
    except OSError:
        return False


class FilterModule:
    def filters(self) -> dict:
        return {"role_has_nocheck": role_has_nocheck}
