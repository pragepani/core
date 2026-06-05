#!/bin/bash
set +e

echo '=== container ps ==='
container ps -a --filter name=matrix-mdad

echo '=== container logs (tail) ==='
container logs --tail=200 matrix-mdad 2>&1

echo '=== systemctl --failed ==='
container exec matrix-mdad systemctl --no-pager --no-legend list-units --state=failed

echo '=== systemctl status matrix-mdad-bootstrap.service ==='
container exec matrix-mdad systemctl --no-pager status matrix-mdad-bootstrap.service

echo '=== journalctl -u matrix-mdad-bootstrap.service ==='
container exec matrix-mdad journalctl --no-pager -u matrix-mdad-bootstrap.service -n 200

echo '=== systemctl status docker.service ==='
container exec matrix-mdad systemctl --no-pager status docker.service

exit 0
