# SSO Tests 🔐

<!-- TODO: req-ref-pin: this directory enforces the unified `services.sso`
     contract from requirement 021. Leaving the live link here is
     intentional — it pins the surface this test directory polices. -->
Integration tests that enforce per-role invariants of the unified
``services.sso`` block (see
[docs/requirements/021-sso-flavor-migration.md](../../../../docs/requirements/021-sso-flavor-migration.md))  <!-- TODO: req-ref-pin -->
across roles, including normalization of ``allowed_groups`` paths and
allocation of per-consumer SSO-proxy ports.

Tests in this directory MUST only cover SSO configuration invariants.
Generic port-uniqueness and port-reference-validity rules MUST live
under `tests/integration/ports/`, and domain-related checks MUST live
under `tests/integration/domains/`.

For framework, directory layout, and `make test-integration` usage see
[integration.md](../../../../docs/contributing/actions/testing/integration.md).
