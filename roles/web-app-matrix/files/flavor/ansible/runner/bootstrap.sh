#!/bin/bash
set -euo pipefail

MARKER=/var/lib/matrix-mdad/bootstrap.done
mkdir -p /var/lib/matrix-mdad
if [ -f "$MARKER" ]; then
  exit 0
fi

export PATH="/opt/ansible/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

cd /mdad
/opt/ansible/bin/ansible-galaxy install -r requirements.yml -p roles/galaxy/ --force
/opt/ansible/bin/ansible-playbook -i inventory/hosts setup.yml --tags="${MATRIX_MDAD_PLAYBOOK_TAGS:-setup-all,start}"

touch "$MARKER"
