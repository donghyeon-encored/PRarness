#!/usr/bin/env bash

set -euo pipefail
set +x

mode=configure
if [[ ${1:-} == "--verify" ]]; then
  mode=verify
  shift
fi

server_url=${CODEX_GITHUB_SERVER_URL:-https://github.com}
host=${server_url#https://}
host=${host#http://}
host=${host%/}
if [[ -z $host || $host == */* ]]; then
  echo 'CODEX_GITHUB_SERVER_URL must contain one GitHub host.' >&2
  exit 2
fi
if [[ $host == github.com ]]; then
  api_url=https://api.github.com
else
  api_url="${server_url%/}/api/v3"
fi
export GH_HOST="$host"

for command_name in git gh; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Required command is missing: $command_name" >&2
    exit 2
  }
done

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo 'Codex Cloud did not provide a Git checkout.' >&2
  exit 2
}
cd "$repo_root"

repository_from_remote_url() {
  local url=${1:-}
  local candidate=''
  case "$url" in
    "${server_url%/}/"*) candidate=${url#"${server_url%/}/"} ;;
    "git://${host}/"*) candidate=${url#"git://${host}/"} ;;
    "ssh://git@${host}/"*) candidate=${url#"ssh://git@${host}/"} ;;
    "git@${host}:"*) candidate=${url#"git@${host}:"} ;;
    *) return 1 ;;
  esac
  candidate=${candidate%/}
  candidate=${candidate%.git}
  if [[ $candidate =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
    printf '%s' "$candidate"
    return 0
  fi
  return 1
}

detect_repository() {
  local configured=${1:-${CODEX_GITHUB_REPOSITORY:-${GITHUB_REPOSITORY:-}}}
  if [[ -n $configured ]]; then
    printf '%s' "$configured"
    return 0
  fi

  local remote_name remote_url candidate existing already_seen
  if remote_url=$(git remote get-url origin 2>/dev/null) && candidate=$(repository_from_remote_url "$remote_url"); then
    printf '%s' "$candidate"
    return 0
  fi

  local -a candidates=()
  while IFS= read -r remote_name; do
    [[ -n $remote_name ]] || continue
    remote_url=$(git remote get-url "$remote_name" 2>/dev/null) || continue
    candidate=$(repository_from_remote_url "$remote_url") || continue
    already_seen=false
    for existing in "${candidates[@]-}"; do
      if [[ $existing == "$candidate" ]]; then
        already_seen=true
        break
      fi
    done
    if [[ $already_seen == false ]]; then
      candidates+=("$candidate")
    fi
  done < <(git remote 2>/dev/null)

  if (( ${#candidates[@]} == 1 )); then
    printf '%s' "${candidates[0]}"
    return 0
  fi
  if (( ${#candidates[@]} > 1 )); then
    echo 'Codex Cloud GitHub setup found multiple GitHub repositories in the checkout remotes.' >&2
    return 2
  fi
  echo 'Set CODEX_GITHUB_REPOSITORY=owner/repository when the Cloud checkout has no GitHub remote.' >&2
  return 2
}

repository=$(detect_repository "${1:-}") || exit $?
if [[ ! $repository =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
  echo 'Codex Cloud GitHub repository must use owner/repository format.' >&2
  exit 2
fi

remote_url="${server_url%/}/${repository}.git"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$remote_url"
else
  git remote add origin "$remote_url"
fi

base64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

mint_installation_token() {
  for command_name in curl jq openssl; do
    command -v "$command_name" >/dev/null 2>&1 || {
      echo "GitHub App authentication requires $command_name." >&2
      return 2
    }
  done

  local app_id=${AGENT_APP_ID:-}
  local private_key=${AGENT_APP_PRIVATE_KEY:-}
  if [[ -z $app_id || -z $private_key ]]; then
    return 1
  fi

  local key_file
  key_file=$(mktemp)
  chmod 600 "$key_file"
  trap 'rm -f "$key_file"' RETURN
  printf '%s\n' "$private_key" > "$key_file"

  local now issued_at expires_at header payload unsigned signature jwt
  now=$(date +%s)
  issued_at=$((now - 60))
  expires_at=$((now + 540))
  header=$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | base64url)
  payload=$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$issued_at" "$expires_at" "$app_id" | base64url)
  unsigned="$header.$payload"
  signature=$(printf '%s' "$unsigned" | openssl dgst -sha256 -sign "$key_file" | base64url)
  jwt="$unsigned.$signature"
  rm -f "$key_file"
  trap - RETURN

  local owner=${repository%%/*}
  local repo_name=${repository#*/}
  local installation_id=${AGENT_APP_INSTALLATION_ID:-}
  if [[ -z $installation_id ]]; then
    installation_id=$(curl --fail --silent --show-error \
      -H "Authorization: Bearer $jwt" \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      "${api_url}/repos/${owner}/${repo_name}/installation" \
      | jq -er '.id')
  fi

  local request_body response
  request_body=$(jq -cn --arg repo "$repo_name" '{repositories:[$repo],permissions:{actions:"write",contents:"write",issues:"write",pull_requests:"write",workflows:"write"}}')
  response=$(curl --fail --silent --show-error \
    -X POST \
    -H "Authorization: Bearer $jwt" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    -d "$request_body" \
    "${api_url}/app/installations/${installation_id}/access_tokens")
  printf '%s' "$response" | jq -er '.token'
}

if [[ $mode == configure ]]; then
  token=${CODEX_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}
  if [[ -z $token ]]; then
    if gh api "repos/$repository" --silent >/dev/null 2>&1; then
      token=''
    else
      token=$(mint_installation_token) || {
        echo 'Configure CODEX_GITHUB_TOKEN or AGENT_APP_ID/AGENT_APP_PRIVATE_KEY in the Codex Cloud environment.' >&2
        exit 2
      }
    fi
  fi

  if [[ -n $token ]]; then
    config_dir=${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}
    mkdir -p "$config_dir"
    chmod 700 "$config_dir"
    hosts_file="$config_dir/hosts.yml"
    hosts_tmp=$(mktemp "$config_dir/hosts.yml.XXXXXX")
    chmod 600 "$hosts_tmp"
    {
      printf '%s:\n' "$host"
      printf '    user: x-access-token\n'
      printf '    oauth_token: %s\n' "$token"
      printf '    git_protocol: https\n'
    } > "$hosts_tmp"
    mv "$hosts_tmp" "$hosts_file"
  fi
  unset token GITHUB_TOKEN GH_TOKEN CODEX_GITHUB_TOKEN AGENT_APP_PRIVATE_KEY
fi

git config --local --unset-all credential."https://${host}".helper >/dev/null 2>&1 || true
git config --local --add credential."https://${host}".helper ''
git config --local --add credential."https://${host}".helper '!gh auth git-credential'
git config --local user.name "${CODEX_GIT_AUTHOR_NAME:-codex-cloud}"
git config --local user.email "${CODEX_GIT_AUTHOR_EMAIL:-codex-cloud@users.noreply.github.com}"

gh api "repos/$repository" --jq '.full_name' | grep -Fqx "$repository"
gh repo set-default "$repository"
git ls-remote --exit-code origin HEAD >/dev/null

echo "Codex Cloud GitHub access ready: origin -> $remote_url; gh -> $repository"
