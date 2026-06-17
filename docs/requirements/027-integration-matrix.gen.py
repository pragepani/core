#!/usr/bin/env python3
"""Generate the role×role integration matrix markdown.

Source of truth for the integration-matrix markdown emitted alongside this
script. Regenerate it from the repository root and commit the regenerated
file. The curated edge data lives in the sibling ``integration_matrix_data``
module; this entrypoint only scans the infinito-native service flags and
renders the table.

Axes are the entity names of every web-app-* and web-svc-* role.
A cell [row][col] marks whether the ROW role ships an addon/plugin that wires
in the COLUMN role:
  - check  -> a real upstream plugin exists (cell links to its page)
  - coin   -> integration exists but is gated behind a commercial/paid tier
  - cross  -> no known plugin
  - dash   -> diagonal (same role)
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
# Standalone docs generator bootstrap: prepend the repo root so the shared
# utils.cache.base.ROLES_DIR helper resolves; this script has no package
# container to import PROJECT_ROOT from.
sys.path.insert(0, str(_HERE.parents[1]))  # nocheck: project-root-import

from integration_matrix_data import (  # noqa: E402
    EDGES,
    ENTITIES,
    FRAMEWORK,
)

from utils.cache.base import ROLES_DIR  # noqa: E402

CHECK = "✅"
WIRED = "☑️"
COIN = "🪙"
CROSS = "❌"
DASH = "—"

_OUTPUT = _HERE / "027-integration-matrix.md"


def scan_framework_edges():
    """Derive infinito-native integration edges from each role's meta/services.yml."""
    edges = []
    for prefix in ("web-app-", "web-svc-"):
        for path in sorted(Path(ROLES_DIR).glob(prefix + "*/meta/services.yml")):
            role = path.parent.parent.name
            entity = role[len(prefix) :]
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except OSError:
                continue
            seen = set()
            for line in lines:
                m = re.match(r"^([a-z0-9_]+):", line)
                if not m:
                    continue
                key = m.group(1)
                target = FRAMEWORK.get(key)
                if target and target != entity and target not in seen:
                    seen.add(target)
                    rel = f"../../roles/{role}/meta/services.yml"
                    edges.append((entity, target, rel, "wired"))
    return edges


def build():
    # Framework (infinito-native) edges first; curated upstream EDGES override
    # them so an explicit plugin link wins over the generic services.yml link.
    by_pair = {(s, d): (url, kind) for (s, d, url, kind) in scan_framework_edges()}
    by_pair.update({(s, d): (url, kind) for (s, d, url, kind) in EDGES})
    corner = "↓ row wires → col"

    def render_row(label, cells):
        # Repeat the row-label column every 10 columns for readability.
        out = [label]
        for j, cell in enumerate(cells):
            out.append(cell)
            if (j + 1) % 10 == 0 and (j + 1) < len(cells):
                out.append(label)
        return "| " + " | ".join(out) + " |"

    header = render_row(corner, ENTITIES)
    ncols = header.count("|") - 1
    sep = "|" + "---|" * ncols
    rows = [header, sep]
    for i, src in enumerate(ENTITIES):
        cells = []
        for dst in ENTITIES:
            if src == dst:
                cells.append(DASH)
            elif (src, dst) in by_pair:
                url, kind = by_pair[(src, dst)]
                sym = {"coin": COIN, "wired": WIRED}.get(kind, CHECK)
                cells.append(f"[{sym}]({url})")
            else:
                cells.append(CROSS)
        rows.append(render_row(f"**{src}**", cells))
        # Repeat the column header every 10 data rows for readability.
        if (i + 1) % 10 == 0 and (i + 1) < len(ENTITIES):
            rows.append(header)
    return "\n".join(rows)


HEADER = """<!-- generated-artifact / not-a-requirement -->
# 027 - Integration Matrix

> Generated artifact — do NOT edit by hand. Edit the curated edge data in
> `integration_matrix_data.py` and re-run the generator from the repo root.

Companion artifact for [026-unified-addon-syntax.md](026-unified-addon-syntax.md).
Axes are the **entity names** of every `web-app-*` and `web-svc-*` role.
A cell marks whether the **row** role ships an addon/plugin that wires in the **column** role.

## Legend

| Symbol | Meaning |
|---|---|
| {wired} | Already wired via an infinito-native service flag in the row role's `meta/services.yml` (group-gated). Links to that declaration. |
| {check} | A verified upstream app↔app plugin exists but is not yet declared as an addon. Links to the plugin page. This is the backlog. |
| {coin} | Integration exists but is gated behind a commercial / paid tier. |
| {cross} | No known integration to wire these two. |
| {dash} | Same role (diagonal). |

Notes:

- The matrix is **directional**: the row hosts the plugin/flag. Bidirectional pairs (e.g. `nextcloud`↔`openproject`) carry a symbol in both cells, each linking to that side.
- {wired} edges are derived automatically by scanning every role's `meta/services.yml` for integration service keys (`sso`→keycloak, `matomo`→matomo, `prometheus`→prometheus, `email`→mailu, `dashboard`, `css`, `logout`, `cdn`, `coturn`, `collabora`, `onlyoffice`, `libretranslate`). `ldap`/`redis`/`mariadb` map to `svc-db-*` roles that are off these axes and are not shown.
- `→ keycloak` {wired} cells are the central `sso` service; a {check}/{coin} on `→ keycloak` instead means a role-local OIDC/SAML addon path beyond the central service.
- Native ActivityPub federation between fediverse roles (`mastodon`, `peertube`, `pixelfed`, `funkwhale`, `mobilizon`, `bookwyrm`, `socialhome`) needs **no plugin** and is therefore not a {check} edge unless an installable connector exists.

## Matrix

{matrix}

## Maintenance

- [ ] Regenerate this matrix after adding or removing any integration edge.
"""


def main():
    fw = scan_framework_edges()
    out = HEADER.format(
        check=CHECK, wired=WIRED, coin=COIN, cross=CROSS, dash=DASH, matrix=build()
    )
    _OUTPUT.write_text(out, encoding="utf-8")
    print(
        f"wrote {_OUTPUT} ({len(ENTITIES)}x{len(ENTITIES)} matrix, "
        f"{len(fw)} wired + {len(EDGES)} upstream edges)"
    )


if __name__ == "__main__":
    main()
