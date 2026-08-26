#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

bootstrap_repository=${PRARNESS_BOOTSTRAP_REPOSITORY:-donghyeon-encored/PRarness}
bootstrap_ref=${PRARNESS_BOOTSTRAP_REF:-}
if [[ ! $bootstrap_repository =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
  echo 'PRARNESS_BOOTSTRAP_REPOSITORY must use owner/repository format.' >&2
  exit 2
fi
if [[ ! $bootstrap_ref =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo 'PRARNESS_BOOTSTRAP_REF must be a reviewed 40-character commit SHA.' >&2
  exit 2
fi

for command_name in curl bash; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required bootstrap command is missing: $command_name" >&2
    exit 2
  }
done

install_dir=${PRARNESS_INSTALL_DIR:-${HOME}/.local/bin}
install_path=${install_dir}/prarness-github-setup
source_url="https://raw.githubusercontent.com/${bootstrap_repository}/${bootstrap_ref}/.github/agent-pipeline/cloud-github-setup.sh"
mkdir -p "$install_dir"
temporary_path=$(mktemp "${install_dir}/prarness-github-setup.XXXXXX")
trap 'rm -f "$temporary_path"' EXIT
curl --fail --silent --show-error --location "$source_url" --output "$temporary_path"
bash -n "$temporary_path"
chmod 700 "$temporary_path"
mv "$temporary_path" "$install_path"
trap - EXIT

"$install_path" "$@"
