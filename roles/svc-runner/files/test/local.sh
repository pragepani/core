#!/usr/bin/env bash
# Local checks for svc-runner: container health, DooD socket, and a full nested
# deploy. Only runs via test-e2e-cli (RUNTIME dev/act/github), always
# containerized — no bare-host path. The deploy builds the infinito image locally
# (no GitHub/GHCR) and runs in a sealed throwaway dockerd.
set -euo pipefail

fail_count=0

echo "DinD mode: verifying runner containers started..."
for i in $(seq 1 "${RUNNER_COUNT}"); do
    # || echo: inspect exits non-zero if absent; keeps set -e from aborting first.
    state=$(container inspect --format '{{.State.Status}}' "${RUNNER_PROJECT_PREFIX}-${i}" 2>/dev/null || echo "not found")
    if [[ "${state}" != "running" ]]; then
        echo "FAIL: ${RUNNER_PROJECT_PREFIX}-${i} is not running (state=${state})"
        fail_count=$((fail_count + 1))
    else
        echo "OK: ${RUNNER_PROJECT_PREFIX}-${i} is running"
    fi
done
[[ "${fail_count}" -eq 0 ]] || { echo "FAIL: ${fail_count} container(s) not healthy in DinD"; exit 1; }

# DooD socket reachable — core capability for running CI jobs.
echo "DinD mode: verifying DooD socket in ${RUNNER_PROJECT_PREFIX}-1..."
if ! docker exec "${RUNNER_PROJECT_PREFIX}-1" docker version >/dev/null 2>&1; then
    echo "FAIL: Docker socket not accessible inside ${RUNNER_PROJECT_PREFIX}-1 — DooD broken in DinD"
    exit 1
fi
echo "OK: DooD socket accessible inside ${RUNNER_PROJECT_PREFIX}-1"

# Full deploy test — purely local, no GitHub. Builds the infinito image on the
# runner (cached on the outer daemon) and deploys web-app-dashboard in a throwaway,
# sealed dockerd so the nested stack can't touch the host's own stack. Same path in
# CI and on a server; tear-down on exit takes the whole nested stack with it.
# Per-instance repo copy: the shared /opt/src/infinito .env/Corefile would make
# inner coredns serve the wrong IP.
_iso_src="${RUNNER_INSTALL_DIR}/1/nested-src"
echo "DinD mode: running full local deploy test inside ${RUNNER_PROJECT_PREFIX}-1..."
container exec --user root "${RUNNER_PROJECT_PREFIX}-1" \
    bash -c "rm -rf ${_iso_src} && mkdir -p ${_iso_src} && tar -C /opt/src/infinito --exclude='./.env' --exclude='./compose/coredns/Corefile' --exclude='./.venvs' --exclude='./venv' --exclude='*/node_modules' --exclude='*/__pycache__' -cf - . | tar -C ${_iso_src} -xf - && chown -R github-runner:github-runner ${_iso_src}"
container exec "${RUNNER_PROJECT_PREFIX}-1" bash -c "cd ${_iso_src} && make install"

if ! container exec "${RUNNER_PROJECT_PREFIX}-1" bash -c '
    set -euo pipefail
    cd "'"${_iso_src}"'"

    # Build the infinito image locally (cached on the outer daemon) — no GHCR pull.
    INFINITO_DISTRO=debian make build
    img="$(INFINITO_DISTRO=debian bash scripts/meta/resolve/image/local.sh)"

    # Throwaway sealed dockerd sharing runner-1 netns (reach at 127.0.0.1:2375);
    # torn down on exit. The repo is mounted in at the same path so the sealed
    # daemon can satisfy the infinito compose bind-mount (.:/opt/src/infinito).
    SB="runner-dind-sandbox"
    docker rm -f "$SB" >/dev/null 2>&1 || true
    trap '"'"'docker rm -f "$SB" >/dev/null 2>&1 || true'"'"' EXIT
    docker run -d --privileged --name "$SB" \
        --network "container:'"${RUNNER_PROJECT_PREFIX}"'-1" \
        -v "'"${_iso_src}"'":"'"${_iso_src}"'" \
        -e DOCKER_TLS_CERTDIR= docker:dind --host=tcp://0.0.0.0:2375 >/dev/null
    export DOCKER_HOST=tcp://127.0.0.1:2375
    ready=0
    for _ in $(seq 1 40); do
        if docker version >/dev/null 2>&1; then ready=1; break; fi
        sleep 2
    done
    [ "$ready" = 1 ] || { echo "FAIL: sealed dind daemon did not come up"; exit 1; }

    # Move the local image into the sealed daemon, then deploy with no build/pull
    # so it uses exactly that image. Owner/repo cleared so all.sh never swaps in a
    # GHCR image; RUNTIME=github runs the E2E roles; CI=true keeps the cache off.
    DOCKER_HOST= docker save "$img" | docker load
    COMPOSE_PROJECT_NAME=infinito INFINITO_RUNNER_PREFIX=infinito \
    RUNTIME=github CI=true apps=web-app-dashboard disable=matomo \
    INFINITO_DEPLOY_TYPE=server INFINITO_DISTROS=debian \
    INFINITO_IMAGE="$img" INFINITO_BUILD=0 INFINITO_PULL_POLICY=never \
    GITHUB_REPOSITORY_OWNER= GITHUB_REPOSITORY= \
    INFINITO_INVENTORY_DIR=/tmp/runner-dind-inventory \
    INFINITO_DOCKER_VOLUME=/tmp/runner-dind-docker \
    ANSIBLE_LOG_PATH=/tmp/ansible-runner-dind-test.log \
    bash scripts/tests/deploy/ci/all.sh
'; then
    echo "FAIL: local full deploy failed"
    exit 1
fi
echo "OK: local full deploy succeeded (sealed sandbox, no GitHub)"

echo "ALL LOCAL CHECKS PASSED (DinD)"
