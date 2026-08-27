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

for command_name in curl bash jq openssl; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required bootstrap command is missing: $command_name" >&2
    exit 2
  }
done

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo 'PRarness bootstrap requires sha256sum or shasum.' >&2
    return 2
  fi
}

runtime_root=${PRARNESS_RUNTIME_DIR:-${HOME}/.local/share/prarness}
install_dir=${PRARNESS_INSTALL_DIR:-${HOME}/.local/bin}
version_dir=${runtime_root}/${bootstrap_ref}
base_url="https://raw.githubusercontent.com/${bootstrap_repository}/${bootstrap_ref}/.github/agent-pipeline"
mkdir -p "$runtime_root" "$install_dir"
chmod 700 "$runtime_root" "$install_dir"

temporary_dir=$(mktemp -d "${runtime_root}/.${bootstrap_ref}.XXXXXX")
cleanup_runtime() {
  rm -rf "$temporary_dir"
}
trap cleanup_runtime EXIT

manifest_path=${temporary_dir}/runtime-manifest.json
curl --fail --silent --show-error --location "${base_url}/runtime-manifest.json" --output "$manifest_path"
jq -e '.version == 1 and .runtime_contract == 1 and (.files | type == "array" and length > 0)' "$manifest_path" >/dev/null || {
  echo 'PRarness runtime manifest is invalid.' >&2
  exit 2
}

while IFS= read -r encoded; do
  entry=$(printf '%s' "$encoded" | openssl base64 -d -A)
  relative_path=$(printf '%s' "$entry" | jq -er '.path')
  expected_sha=$(printf '%s' "$entry" | jq -er '.sha256')
  executable=$(printf '%s' "$entry" | jq -r '.executable // false')
  if [[ ! $relative_path =~ ^[A-Za-z0-9._/-]+$ || $relative_path == /* || $relative_path == *..* || ! $expected_sha =~ ^[0-9a-f]{64}$ ]]; then
    echo 'PRarness runtime manifest contains an unsafe file entry.' >&2
    exit 2
  fi
  destination=${temporary_dir}/${relative_path}
  mkdir -p "$(dirname "$destination")"
  curl --fail --silent --show-error --location "${base_url}/${relative_path}" --output "$destination"
  actual_sha=$(sha256_file "$destination")
  if [[ $actual_sha != "$expected_sha" ]]; then
    echo "PRarness runtime checksum failed for ${relative_path}." >&2
    exit 2
  fi
  if [[ $executable == true ]]; then chmod 700 "$destination"; else chmod 600 "$destination"; fi
done < <(jq -r '.files[] | @base64' "$manifest_path")

if [[ -e $version_dir ]]; then
  rm -rf "$version_dir"
fi
mv "$temporary_dir" "$version_dir"
trap - EXIT

ln -sfn "${version_dir}/cloud-github-setup.sh" "${install_dir}/prarness-github-setup"
ln -sfn "${version_dir}/repository-check.mjs" "${install_dir}/prarness-repository-check"
ln -sfn "${version_dir}/cloud-github.mjs" "${install_dir}/prarness-github"
ln -sfn "${version_dir}/cloud-publish.mjs" "${install_dir}/prarness-publish"

"${install_dir}/prarness-github-setup" "$@"
