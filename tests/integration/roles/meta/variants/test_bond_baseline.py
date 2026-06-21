"""Integration guard: a dynamic ``"{{ '<role>' in group_names }}"`` flag's
variant placement MUST follow its ``bond``.

- ``bond >= 1`` (tightly coupled, same host): the service shares the role's
  host, so variant 0 (the host baseline) MUST pin the flag to literal ``true``.
- ``bond < 1`` (loosely coupled, separate host): the partner deploys on its own
  host (see the bond-aware ``test_order``) and may be distributed across the
  matrix to keep each host under the memory budget, so at least ONE variant
  (variant 0 or any other) MUST pin the flag to literal ``true``.

Only dynamic flags are governed: literal ``true``/``false`` and non-group_names
expressions (own containers, env-gated services) are not variant-controllable.

Exempt a service with ``# nocheck: bond-baseline`` on (or directly above) its
``meta/services.yml`` key.
"""

from __future__ import annotations

import re
import unittest
from typing import TYPE_CHECKING

from utils.cache.files import read_text
from utils.cache.yaml import load_yaml_any
from utils.roles.mapping import (
    ROLE_FILE_META_SERVICES,
    ROLE_FILE_META_VARIANTS,
    ROLE_TYPE_APPLICATION,
)
from utils.roles.type import get_role_types

from . import PROJECT_ROOT

if TYPE_CHECKING:
    from pathlib import Path

ROLES_DIR = PROJECT_ROOT / "roles"
_MISSING = object()
_NOCHECK_RE = re.compile(r"#\s*nocheck:\s*bond-baseline\b")


def _service_nocheck(lines: list[str], key: str) -> bool:
    pat = re.compile(r"^" + re.escape(key) + r"\s*:")
    for i, line in enumerate(lines):
        if not pat.match(line):
            continue
        if _NOCHECK_RE.search(line):
            return True
        j = i - 1
        while j >= 0 and lines[j].lstrip().startswith("#"):
            if _NOCHECK_RE.search(lines[j]):
                return True
            j -= 1
        return False
    return False


def _is_dynamic_flag(value: object) -> bool:
    return isinstance(value, str) and "in group_names" in value


def _bond_of(entry: object) -> float:
    if not isinstance(entry, dict):
        return 1.0
    raw = entry.get("bond", 1.0)
    if isinstance(raw, bool):
        return 1.0
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 1.0


def _load_yaml(path: Path) -> object:
    if not path.is_file():
        return None
    try:
        return load_yaml_any(str(path), default_if_missing=None)
    except Exception:
        return None


def _override(variant: dict, key: str, flag: str) -> object:
    services = variant.get("services") if isinstance(variant, dict) else None
    if not isinstance(services, dict):
        return _MISSING
    entry = services.get(key)
    if not isinstance(entry, dict) or flag not in entry:
        return _MISSING
    return entry[flag]


class TestBondBaseline(unittest.TestCase):
    def test_coupled_flags_pinned_in_variant0_loose_flags_anywhere(self) -> None:
        offenders: list[str] = []

        for role_dir in sorted(p for p in ROLES_DIR.iterdir() if p.is_dir()):
            role = role_dir.name
            if ROLE_TYPE_APPLICATION not in get_role_types(role_dir):
                continue
            services = _load_yaml(role_dir / ROLE_FILE_META_SERVICES)
            if not isinstance(services, dict):
                continue
            variants = _load_yaml(role_dir / ROLE_FILE_META_VARIANTS)
            if not isinstance(variants, list) or not variants:
                continue
            vlist = [v if isinstance(v, dict) else {} for v in variants]
            v0 = vlist[0]
            try:
                services_lines = read_text(
                    str(role_dir / ROLE_FILE_META_SERVICES)
                ).splitlines()
            except OSError:
                services_lines = []

            for key, entry in services.items():
                if not isinstance(entry, dict):
                    continue
                if _service_nocheck(services_lines, key):
                    continue
                coupled = _bond_of(entry) >= 1.0
                for flag in ("enabled", "shared"):
                    if not _is_dynamic_flag(entry.get(flag)):
                        continue
                    if coupled:
                        if _override(v0, key, flag) is not True:
                            offenders.append(
                                f"{role}: bond>=1 services.{key}.{flag} is dynamic "
                                f"but variant 0 does not pin it ``true`` — a "
                                f"same-host service must be in the host baseline."
                            )
                    elif not any(_override(v, key, flag) is True for v in vlist):
                        offenders.append(
                            f"{role}: bond<1 services.{key}.{flag} is dynamic but "
                            f"no variant pins it ``true`` — a separate-host partner "
                            f"must be enabled in at least one variant."
                        )

        if offenders:
            self.fail(
                "bond/variant-0 baseline placement is wrong "
                f"({len(offenders)} offender(s)):\n"
                + "\n".join(f"  - {o}" for o in offenders)
            )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
