#!/usr/bin/env bash
# Local checks for svc-runner: container health, DooD socket, and (in CI) a full
# nested deploy. Always runs inside the containerized deploy — test-e2e-cli only
# fires for RUNTIME dev/act/github, which all run in a container — so there is no
# bare-host path. The full deploy test needs GITHUB_TOKEN + a ci-<sha> image tag
# so runner-1 can pull from GHCR.
set -euo pipefail

fail_count=0

echo "DinD mode: verifying runner containers started..."
for i in $(seq 1 "${RUNNER_COUNT}"); do
    # || echo "not found": container inspect exits non-zero when container
    # does not exist; without this set -e would kill the script before
    # fail_count can be incremented.
    state=$(container inspect --format '{{.State.Status}}' "${RUNNER_PROJECT_PREFIX}-${i}" 2>/dev/null || echo "not found")
    if [[ "${state}" != "running" ]]; then
        echo "FAIL: ${RUNNER_PROJECT_PREFIX}-${i} is not running (state=${state})"
        fail_count=$((fail_count + 1))
    else
        echo "OK: ${RUNNER_PROJECT_PREFIX}-${i} is running"
    fi
done
[[ "${fail_count}" -eq 0 ]] || { echo "FAIL: ${fail_count} container(s) not healthy in DinD"; exit 1; }

# Verify DooD socket is reachable — core capability for running CI jobs.
echo "DinD mode: verifying DooD socket in ${RUNNER_PROJECT_PREFIX}-1..."
if ! docker exec "${RUNNER_PROJECT_PREFIX}-1" docker version >/dev/null 2>&1; then
    echo "FAIL: Docker socket not accessible inside ${RUNNER_PROJECT_PREFIX}-1 — DooD broken in DinD"
    exit 1
fi
echo "OK: DooD socket accessible inside ${RUNNER_PROJECT_PREFIX}-1"

# Full deploy test — mirrors test-runner-smoke.yml but runs inside runner-1
# using DooD into the DinD daemon instead of the host Docker socket.
# Skipped locally: GITHUB_TOKEN is absent and INFINITO_IMAGE_TAG=latest
# (no ci-<sha> image exists outside of CI).
if [[ -n "${GITHUB_TOKEN:-}" ]] && [[ "${INFINITO_IMAGE_TAG:-}" == ci-* ]]; then
    echo "DinD mode: running full deploy test inside ${RUNNER_PROJECT_PREFIX}-1..."

    # Run from a per-instance copy, not the shared /opt/src/infinito (the
    # outer runner's .env/Corefile there would make inner coredns serve the
    # wrong IP). Same-path dir keeps DooD bind-mounts valid.
    _iso_src="${RUNNER_INSTALL_DIR}/1/nested-src"
    container exec --user root "${RUNNER_PROJECT_PREFIX}-1" \
        bash -c "rm -rf ${_iso_src} && mkdir -p ${_iso_src} && tar -C /opt/src/infinito --exclude='./.env' --exclude='./compose/coredns/Corefile' --exclude='./.venvs' --exclude='./venv' --exclude='*/node_modules' --exclude='*/__pycache__' -cf - . | tar -C ${_iso_src} -xf - && chown -R github-runner:github-runner ${_iso_src}"

    # Authenticate to GHCR so runner-1 can pull the infinito CI image via DooD.
    # docker login runs INSIDE runner-1 (no container wrapper there); <<< avoids
    # the pipe pattern that would trigger the raw-docker lint rule.
    container exec -e "GITHUB_TOKEN=${GITHUB_TOKEN}" "${RUNNER_PROJECT_PREFIX}-1" \
        bash -c "docker login ghcr.io -u github-actions --password-stdin <<< \"\${GITHUB_TOKEN}\""

    # Install Ansible and Python dependencies (same as a real CI job would do).
    container exec "${RUNNER_PROJECT_PREFIX}-1" \
        bash -c "cd ${_iso_src} && make install"

    # Deploy web-app-dashboard exactly as the smoke test does, retrying up to
    # ${deploy_attempts} times. DooD routes Docker commands to the DinD daemon,
    # so the infinito container and web-app-dashboard containers are created
    # inside DinD — the same topology as production, one Docker level down.
    #
    # Retry rationale: over the multi-hop DinD egress the nested apt index is
    # occasionally pulled incomplete — apt-get update reports success but a
    # component is missing, so the first package install fails with
    # "no installation candidate". This path does not happen on single-hop
    # GitHub-hosted runners. Each attempt wipes nested state and re-pulls the
    # index from scratch, matching a fresh CI run.
    #
    # Override COMPOSE_PROJECT_NAME / INFINITO_RUNNER_PREFIX: runner-1's
    # own env_file sets both to "runner-1". Without overriding, the nested
    # infinito stack would inherit that project name and try to reuse the
    # pre-existing "runner-1_default" network (auto-subnet, created by the
    # runner's own compose project) — its subnet does not contain the
    # 172.30.0.0/24 static IPs the infinito stack assigns, so attach fails
    # with "no configured subnet contains IP address". Pinning to
    # "infinito" makes the nested stack create its own isolated,
    # correctly-subnetted "infinito_default" network, matching normal CI.
    # RUNTIME=github runs the E2E roles (test-e2e-cli + test-e2e-playwright)
    # like a real CI deploy; the required_by guard expects test-e2e-cli to
    # execute. CI=true makes the deploy behave like GitHub-hosted CI:
    # the package-cache stays off (registry_cache_active = not is_ci), so
    # apt/pip/npm/image pulls go direct — avoiding the flaky nested cache.
    deploy_attempts=3
    deploy_ok=0
    for attempt in $(seq 1 "${deploy_attempts}"); do
        echo "DinD mode: nested deploy attempt ${attempt}/${deploy_attempts}..."

        # Start from clean nested state, like a fresh CI run. /etc/nginx is a
        # named volume (svc-prx-openresty meta/volumes.yml); a prior run can
        # leave nginx.conf there as a directory, breaking the openresty
        # bootstrap. Remove the nested project's containers + volumes first.
        container exec "${RUNNER_PROJECT_PREFIX}-1" \
            bash -c "docker ps -aq --filter label=com.docker.compose.project=infinito | xargs -r docker rm -f" \
            || true
        container exec "${RUNNER_PROJECT_PREFIX}-1" \
            bash -c "docker volume ls -q --filter name=^infinito_ | xargs -r docker volume rm" \
            || true

        if container exec \
            -e "COMPOSE_PROJECT_NAME=infinito" \
            -e "INFINITO_RUNNER_PREFIX=infinito" \
            -e "RUNTIME=github" \
            -e "CI=true" \
            -e "apps=web-app-dashboard" \
            -e "disable=matomo" \
            -e "INFINITO_DEPLOY_TYPE=server" \
            -e "INFINITO_DISTROS=debian" \
            -e "INFINITO_INVENTORY_DIR=/tmp/runner-dind-inventory" \
            -e "INFINITO_DOCKER_VOLUME=/tmp/runner-dind-docker" \
            -e "INFINITO_IMAGE_TAG=${INFINITO_IMAGE_TAG}" \
            -e "INFINITO_GHCR_MIRROR_PREFIX=${INFINITO_GHCR_MIRROR_PREFIX:-}" \
            -e "GITHUB_TOKEN=${GITHUB_TOKEN}" \
            -e "GITHUB_REPOSITORY=${GITHUB_REPOSITORY:-}" \
            -e "GITHUB_REPOSITORY_OWNER=${GITHUB_REPOSITORY_OWNER:-}" \
            -e "ANSIBLE_LOG_PATH=/tmp/ansible-runner-dind-test.log" \
            "${RUNNER_PROJECT_PREFIX}-1" \
            bash "${_iso_src}/scripts/tests/deploy/ci/all.sh"; then
            deploy_ok=1
            break
        fi
        echo "WARN: nested deploy attempt ${attempt}/${deploy_attempts} failed"
    done

    [[ "${deploy_ok}" -eq 1 ]] || { echo "FAIL: nested deploy failed after ${deploy_attempts} attempts"; exit 1; }
    echo "OK: full deploy inside ${RUNNER_PROJECT_PREFIX}-1 succeeded"
else
    echo "DinD mode: skipping full deploy test (GITHUB_TOKEN absent or INFINITO_IMAGE_TAG is not ci-<sha>)"
fi

echo "ALL LOCAL CHECKS PASSED (DinD)"
