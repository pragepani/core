"""Lint guard: services with a static ``enabled: true`` baseline and a
dynamic ``shared`` flag MUST have exactly one ``shared: false`` variant.

Why
---

Those services are always enabled for the owning role, but their provider may
be either shared with another role or deployed locally. One local-only
``shared: false`` variant is enough to exercise that branch. Additional
``shared: false`` variants waste resources because each round has to deploy a
separate provider instance instead of reusing the shared one.

Suppression
-----------

Place ``# nocheck: variants-shared-false-once`` on the ``shared: false`` line
or on the matching service key line in ``meta/variants.yml`` to ignore one
extra pin. Place the same marker above the service key in ``meta/services.yml``
to exempt the service entirely.
"""

from __future__ import annotations

import unittest
from dataclasses import dataclass
from typing import TYPE_CHECKING

from utils.annotations.suppress import is_suppressed_at, line_has_rule
from utils.cache.files import read_text
from utils.cache.yaml import load_yaml_any
from utils.roles.mapping import ROLE_FILE_META_SERVICES, ROLE_FILE_META_VARIANTS

from . import PROJECT_ROOT

if TYPE_CHECKING:
    from pathlib import Path


ROLES_DIR = PROJECT_ROOT / "roles"
_RULE = "variants-shared-false-once"


@dataclass(frozen=True)
class SharedFalsePin:
    variant_index: int
    service_key: str
    line_no: int
    suppressed: bool


def _is_dynamic_shared(value: object) -> bool:
    return isinstance(value, str) and "in group_names" in value


def _services_suppressed_in_base(services_file: Path) -> set[str]:
    """Return service keys whose leading comment block carries this rule."""
    suppressed: set[str] = set()
    pending = False
    for raw_line in read_text(str(services_file)).splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("#"):
            if line_has_rule(raw_line, _RULE):
                pending = True
            continue
        if not stripped:
            pending = False
            continue
        is_top_level = not raw_line.startswith((" ", "\t"))
        if pending and is_top_level and ":" in stripped:
            key = stripped.split(":", 1)[0].strip()
            if key:
                suppressed.add(key)
        pending = False
    return suppressed


def _static_enabled_dynamic_shared_keys(services_file: Path) -> set[str]:
    services = load_yaml_any(str(services_file), default_if_missing={}) or {}
    if not isinstance(services, dict):
        return set()

    suppressed = _services_suppressed_in_base(services_file)
    return {
        key
        for key, entry in services.items()
        if isinstance(key, str)
        and key not in suppressed
        and isinstance(entry, dict)
        and entry.get("enabled") is True
        and _is_dynamic_shared(entry.get("shared"))
    }


def _value_is_literal_false(value_part: str) -> bool:
    return value_part.split("#", 1)[0].strip().lower() == "false"


def _variant_shared_false_pins(variants_file: Path) -> list[SharedFalsePin]:
    lines = read_text(str(variants_file)).splitlines()
    pins: list[SharedFalsePin] = []
    variant_index = -1
    stack: list[tuple[int, str, int]] = []

    for idx, raw_line in enumerate(lines, start=1):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        if raw_line.startswith("- "):
            variant_index += 1
            stack = []
            indent = 2
            line_for_key = raw_line[2:]
        else:
            indent = len(raw_line) - len(raw_line.lstrip(" "))
            line_for_key = stripped

        while stack and stack[-1][0] >= indent:
            stack.pop()

        if ":" not in line_for_key:
            continue

        key, value_part = line_for_key.split(":", 1)
        key = key.strip()
        if not key:
            continue

        stack.append((indent, key, idx))
        path = [item_key for _, item_key, _ in stack]
        if len(path) != 3 or path[0] != "services" or path[2] != "shared":
            continue
        if not _value_is_literal_false(value_part):
            continue

        service_key = path[1]
        service_line_no = stack[1][2]
        suppressed = is_suppressed_at(lines, idx, _RULE) or is_suppressed_at(
            lines, service_line_no, _RULE
        )
        pins.append(
            SharedFalsePin(
                variant_index=variant_index,
                service_key=service_key,
                line_no=idx,
                suppressed=suppressed,
            )
        )

    return pins


class TestVariantSharedFalseOnce(unittest.TestCase):
    def test_static_enabled_dynamic_shared_services_have_one_local_variant(self):
        offenders: list[str] = []

        for role_dir in sorted(path for path in ROLES_DIR.iterdir() if path.is_dir()):
            role_name = role_dir.name
            services_file = role_dir / ROLE_FILE_META_SERVICES
            variants_file = role_dir / ROLE_FILE_META_VARIANTS
            if not (services_file.is_file() and variants_file.is_file()):
                continue

            try:
                service_keys = _static_enabled_dynamic_shared_keys(services_file)
            except Exception as exc:
                offenders.append(f"{role_name}: meta/services.yml parse error: {exc}")
                continue
            if not service_keys:
                continue

            try:
                load_yaml_any(str(variants_file), default_if_missing=[])
            except Exception as exc:
                offenders.append(f"{role_name}: meta/variants.yml parse error: {exc}")
                continue

            pins_by_key: dict[str, list[SharedFalsePin]] = {
                key: [] for key in service_keys
            }
            for pin in _variant_shared_false_pins(variants_file):
                if pin.service_key in pins_by_key and not pin.suppressed:
                    pins_by_key[pin.service_key].append(pin)

            for service_key in sorted(service_keys):
                pins = pins_by_key[service_key]
                if len(pins) == 1:
                    continue
                if not pins:
                    offenders.append(
                        f"{role_name}: services.{service_key} has "
                        f"`enabled: true` with dynamic `shared`, but no "
                        f"unsuppressed variant pins "
                        f"`services.{service_key}.shared: false`. Add exactly "
                        f"one local-provider variant or mark the base service "
                        f"with `# nocheck: {_RULE}`."
                    )
                    continue

                locations = ", ".join(
                    f"variant[{pin.variant_index}] line {pin.line_no}" for pin in pins
                )
                offenders.append(
                    f"{role_name}: services.{service_key} has `enabled: true` "
                    f"with dynamic `shared`, but {len(pins)} variants pin "
                    f"`shared: false` ({locations}). Keep exactly one "
                    f"unsuppressed local-provider variant; for intentional "
                    f"extras, mark the extra `shared: false` line with "
                    f"`# nocheck: {_RULE}`."
                )

        if offenders:
            self.fail(
                f"Static-enabled dynamic-shared services must have exactly one "
                f"`shared: false` variant ({_RULE}, {len(offenders)} offender(s)):\n"
                + "\n".join(f"  - {offender}" for offender in offenders)
            )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
