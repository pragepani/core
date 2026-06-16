#!/usr/bin/env bash
# Local checks for svc-runner: container health, runner process, and DooD.
# In DinD mode the runner entrypoint sleeps (no GitHub token available);
# only container start is verifiable in that environment.
set -euo pipefail

fail_count=0

# --- DinD: entrypoint sleeps; only verify containers started ---
if [[ "${DOCKER_IN_CONTAINER}" == "true" ]]; then
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
    echo "ALL LOCAL CHECKS PASSED (DinD)"
    exit 0
fi

# --- Real host: container health + runner process + DooD ---
echo "Verifying containers, runner process, and Docker socket access..."
for i in $(seq 1 "${RUNNER_COUNT}"); do
    container="${RUNNER_PROJECT_PREFIX}-${i}"

    # 1) Container is running
    state=$(container inspect --format '{{.State.Status}}' "${container}" 2>/dev/null || echo "not found")
    if [[ "${state}" != "running" ]]; then
        echo "FAIL: ${container} is not running (state=${state})"
        fail_count=$((fail_count + 1))
        continue
    fi
    echo "OK: ${container} is running"

    # 2) Runner process is alive inside the container
    if ! docker exec "${container}" pgrep -f "run.sh" >/dev/null 2>&1; then
        echo "FAIL: run.sh not found inside ${container} — runner may have crashed after registration"
        fail_count=$((fail_count + 1))
    else
        echo "OK: ${container} has active runner process"
    fi

    # 3) Docker socket reachable from inside the container (DooD).
    # Proves the runner can actually execute CI job steps that use Docker.
    if ! docker exec "${container}" docker version >/dev/null 2>&1; then
        echo "FAIL: Docker socket not accessible from inside ${container} — DooD broken; runner cannot run CI jobs"
        fail_count=$((fail_count + 1))
    else
        echo "OK: ${container} can reach Docker socket (DooD works)"
    fi
done

[[ "${fail_count}" -eq 0 ]] || { echo "FAIL: ${fail_count} local check(s) failed"; exit 1; }
echo "ALL LOCAL CHECKS PASSED"
