#!/usr/bin/env python3
"""CLI entrypoint: list and aggregate the compose services of a role and its
shared dependencies, with optional variant overlay, depth limit, filtering and
ordering. Collection / aggregation / query / rendering live in sibling modules."""

from __future__ import annotations

import argparse
import sys
from typing import Any

from . import PROJECT_ROOT

sys.path.insert(0, str(PROJECT_ROOT))

from utils.cache.applications import get_variants
from utils.roles.applications.services.registry import (
    build_service_registry_from_applications,
    load_applications_from_roles_dir,
)
from utils.roles.applications.services.resources import (
    SUMMABLE_FIELDS,
    aggregate,
    collect_role_resources,
)

from .query import apply_filters, apply_order
from .render import (
    DEFAULT_TOTAL_LABEL,
    render_json,
    render_summary_json,
    render_summary_text,
    render_text,
)

ROLES_DIR = PROJECT_ROOT / "roles"


def _resolve_order(tokens: list[str] | None) -> tuple[str, str] | None:
    if not tokens:
        return None
    if len(tokens) == 1:
        return ("asc", tokens[0])
    direction, field = tokens[0].lower(), tokens[1]
    if direction not in ("asc", "desc"):
        raise SystemExit(f"--order direction must be asc|desc, got '{tokens[0]}'")
    return (direction, field)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "List and aggregate the compose services of an Ansible role and its "
            "shared dependencies (resolved recursively via the service registry). "
            "mem_reservation/mem_limit are summed, pids_limit is summed as a "
            "max-provisioned host-pid budget, cpus is max."
        )
    )
    parser.add_argument(
        "--role",
        default=None,
        help="Role name (directory under roles/), e.g. web-app-peertube. Three "
        "modes: (1) --role without --variant: one row per variant of that role "
        "(mem/pids = sum, cpus = max). (2) --role with --variant N: the detailed "
        "per-service table for that variant. (3) no --role: one row per role (its "
        "heaviest variant, or the --variant N footprint of every role).",
    )
    parser.add_argument(
        "-f",
        "--format",
        choices=("text", "json"),
        default="text",
        help="Output format (default: text).",
    )
    parser.add_argument(
        "--order",
        nargs="+",
        metavar="[asc|desc] FIELD",
        help="Order rows by FIELD. FIELD is one of service, role, depth, bond, "
        "mem_reservation, mem_limit, pids_limit, cpus. Direction defaults to asc.",
    )
    parser.add_argument(
        "--filter",
        metavar="EXPR",
        help="Filter rows, e.g. 'bond<=0.5 & cpus>=1 & mem_limit>=512m'. Fields: "
        "bond, depth, mem_reservation, mem_limit, pids_limit, cpus. Operators: "
        "<= >= < > == != ; combine with '&'.",
    )
    parser.add_argument(
        "--depth",
        type=int,
        default=0,
        help="Max recursion depth over parent/shared services (0 = unlimited). "
        "1 = the role's own services only.",
    )
    parser.add_argument(
        "--variant",
        type=int,
        default=None,
        help="Variant index from the role's meta/variants.yml (default: base "
        "config). Applies the same variant overlay as inventory creation.",
    )
    parser.add_argument(
        "--sum",
        nargs="*",
        metavar="FIELD",
        default=None,
        help="Show a SUM row instead of the default total. Bare --sum sums all "
        "fields (mem_reservation, mem_limit, pids_limit, cpus, bond); pass field "
        "names to sum only those.",
    )
    parser.add_argument(
        "--unshared",
        action="store_true",
        help="List every service occurrence individually instead of loading each "
        "service only once (the default deduplicates shared services).",
    )
    return parser.parse_args()


def _max_over_none(values: Any) -> Any:
    present = [v for v in values if v is not None]
    return max(present) if present else None


def _aggregate_role_at(
    role: str,
    applications: dict[str, Any],
    service_registry: dict[str, Any],
    variant_conf: Any,
    max_depth: int,
    dedup: bool,
) -> dict[str, Any]:
    """Aggregate (mem_reservation/mem_limit/pids_limit summed, cpus max) for one
    role at one variant overlay (or the base config when variant_conf is None).
    Collection warnings are discarded to keep the summary views readable."""
    apps = applications
    if variant_conf is not None:
        apps = dict(applications)
        apps[role] = variant_conf or {}
    rows: list[dict[str, Any]] = []
    collect_role_resources(
        role_name=role,
        applications=apps,
        service_registry=service_registry,
        visited=set(),
        rows=rows,
        warnings=[],
        max_depth=max_depth,
        dedup=dedup,
    )
    return aggregate(rows)


def _summary_row(key_field: str, key_value: Any, agg: dict[str, Any]) -> dict[str, Any]:
    return {
        key_field: key_value,
        "service": "",
        "depth": None,
        "bond_float": None,
        "mem_reservation_bytes": agg.get("mem_reservation_bytes"),
        "mem_limit_bytes": agg.get("mem_limit_bytes"),
        "pids_limit_int": agg.get("pids_limit_int"),
        "cpus_float": agg.get("cpus_float"),
    }


def _role_resource_row(
    role: str,
    applications: dict[str, Any],
    service_registry: dict[str, Any],
    variants_per_app: dict[str, Any],
    variant_index: int | None,
    max_depth: int,
    dedup: bool,
) -> dict[str, Any]:
    """One per-role footprint row: the heaviest variant (max of the per-variant
    sums for mem_reservation/mem_limit/pids_limit, max for cpus), or the chosen
    variant's sum/max when variant_index is given."""
    app_variants = variants_per_app.get(role) or []

    def agg_at(conf: Any) -> dict[str, Any]:
        return _aggregate_role_at(
            role, applications, service_registry, conf, max_depth, dedup
        )

    if variant_index is not None:
        in_range = 0 <= variant_index < len(app_variants)
        agg = agg_at(app_variants[variant_index] if in_range else None)
    elif app_variants:
        per_variant = [agg_at(conf) for conf in app_variants]
        agg = {
            "mem_reservation_bytes": _max_over_none(
                a["mem_reservation_bytes"] for a in per_variant
            ),
            "mem_limit_bytes": _max_over_none(
                a["mem_limit_bytes"] for a in per_variant
            ),
            "pids_limit_int": _max_over_none(a["pids_limit_int"] for a in per_variant),
            "cpus_float": _max_over_none(a["cpus_float"] for a in per_variant),
        }
    else:
        agg = agg_at(None)

    return _summary_row("role", role, agg)


def _run_role_variants(
    args: argparse.Namespace,
    order: tuple[str, str] | None,
    applications: dict[str, Any],
) -> int:
    variants_per_app = get_variants(roles_dir=str(ROLES_DIR))
    service_registry = build_service_registry_from_applications(applications)
    app_variants = variants_per_app.get(args.role) or []
    dedup = not args.unshared

    warnings: list[str] = []
    rows: list[dict[str, Any]] = []
    if app_variants:
        for idx, conf in enumerate(app_variants):
            agg = _aggregate_role_at(
                args.role, applications, service_registry, conf, args.depth, dedup
            )
            rows.append(_summary_row("variant", idx, agg))
    else:
        agg = _aggregate_role_at(
            args.role, applications, service_registry, None, args.depth, dedup
        )
        rows.append(_summary_row("variant", "base", agg))
        warnings.append(
            f"role '{args.role}' has no meta/variants.yml; showing base config"
        )

    try:
        rows = apply_filters(rows, args.filter)
    except ValueError as exc:
        raise SystemExit(f"--filter: {exc}") from exc

    presorted = False
    if order is not None:
        try:
            rows = apply_order(rows, order[0], order[1])
        except ValueError as exc:
            raise SystemExit(f"--order: {exc}") from exc
        presorted = True

    title = f"Resource footprint per variant of {args.role} (mem/pids=sum, cpus=max)"
    label = "per variant: mem/pids=sum, cpus=max"
    if args.format == "json":
        print(render_summary_json(rows, "variant", label, warnings))
    else:
        print(
            render_summary_text(rows, "variant", title, warnings, presorted=presorted)
        )
    return 0


def _run_all_roles(
    args: argparse.Namespace,
    order: tuple[str, str] | None,
    applications: dict[str, Any],
) -> int:
    variants_per_app = get_variants(roles_dir=str(ROLES_DIR))
    service_registry = build_service_registry_from_applications(applications)

    roles = [
        _role_resource_row(
            role,
            applications,
            service_registry,
            variants_per_app,
            args.variant,
            args.depth,
            not args.unshared,
        )
        for role in sorted(applications)
    ]

    try:
        roles = apply_filters(roles, args.filter)
    except ValueError as exc:
        raise SystemExit(f"--filter: {exc}") from exc

    presorted = False
    if order is not None:
        try:
            roles = apply_order(roles, order[0], order[1])
        except ValueError as exc:
            raise SystemExit(f"--order: {exc}") from exc
        presorted = True

    if args.variant is not None:
        label = f"variant {args.variant}: mem/pids=sum, cpus=max"
    else:
        label = "heaviest variant: mem/pids=max(variant-sum), cpus=max"
    title = f"Resource footprint per role ({label})"

    if args.format == "json":
        print(render_summary_json(roles, "role", label, warnings=[]))
    else:
        print(
            render_summary_text(roles, "role", title, warnings=[], presorted=presorted)
        )
    return 0


def main() -> int:
    args = parse_args()
    order = _resolve_order(args.order)

    applications = load_applications_from_roles_dir(ROLES_DIR)

    if args.role is None:
        return _run_all_roles(args, order, applications)

    if args.variant is None:
        return _run_role_variants(args, order, applications)

    warnings: list[str] = []

    if args.variant is not None:
        app_variants = get_variants(roles_dir=str(ROLES_DIR)).get(args.role) or []
        if 0 <= args.variant < len(app_variants):
            applications = dict(applications)
            applications[args.role] = app_variants[args.variant] or {}
        else:
            warnings.append(
                f"variant {args.variant} out of range for '{args.role}' "
                f"({len(app_variants)} variant(s)); using base config"
            )

    service_registry = build_service_registry_from_applications(applications)

    rows: list[dict[str, Any]] = []
    collect_role_resources(
        role_name=args.role,
        applications=applications,
        service_registry=service_registry,
        visited=set(),
        rows=rows,
        warnings=warnings,
        max_depth=args.depth,
        dedup=not args.unshared,
    )

    try:
        rows = apply_filters(rows, args.filter)
    except ValueError as exc:
        raise SystemExit(f"--filter: {exc}") from exc

    try:
        totals = aggregate(rows, sum_fields=args.sum)
    except ValueError as exc:
        raise SystemExit(f"--sum: {exc}") from exc

    if args.sum is None:
        total_label = DEFAULT_TOTAL_LABEL
    else:
        total_label = "SUM (" + ", ".join(args.sum or sorted(SUMMABLE_FIELDS)) + ")"

    presorted = False
    if order is not None:
        try:
            rows = apply_order(rows, order[0], order[1])
        except ValueError as exc:
            raise SystemExit(f"--order: {exc}") from exc
        presorted = True

    if args.format == "json":
        print(render_json(args.role, rows, totals, warnings))
    else:
        print(
            render_text(
                args.role,
                rows,
                totals,
                warnings,
                presorted=presorted,
                total_label=total_label,
            )
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
