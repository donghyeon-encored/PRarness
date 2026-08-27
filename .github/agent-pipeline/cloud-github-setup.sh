#!/usr/bin/env bash

set -euo pipefail
set +x
umask 077

mode=configure
case ${1:-} in
  --verify|--verify-write)
    mode=verify
    shift
    ;;
esac

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

local_head=$(git rev-parse --verify HEAD 2>/dev/null) || {
  echo 'Codex Cloud checkout has no commit to identify.' >&2
  exit 2
}

github_api_get() {
  local credential=$1
  local url=$2
  curl --fail --silent --show-error --location \
    -H "Authorization: Bearer $credential" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$url"
}

github_api_post() {
  local credential=$1
  local body=$2
  local url=$3
  curl --fail --silent --show-error --location \
    -X POST \
    -H "Authorization: Bearer $credential" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    -d "$body" \
    "$url"
}

base64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

require_app_commands() {
  local command_name
  for command_name in curl jq openssl; do
    command -v "$command_name" >/dev/null 2>&1 || {
      echo "GitHub App authentication requires $command_name." >&2
      return 2
    }
  done
}

write_app_private_key() {
  local key_file=$1
  local private_key=${AGENT_APP_PRIVATE_KEY:-}
  local first_character last_character encoded_key

  private_key=${private_key//$'\r'/}
  if (( ${#private_key} >= 2 )); then
    first_character=${private_key:0:1}
    last_character=${private_key: -1}
    if [[ ( $first_character == '"' && $last_character == '"' ) ||
          ( $first_character == "'" && $last_character == "'" ) ]]; then
      private_key=${private_key:1:${#private_key}-2}
    fi
  fi

  if [[ $private_key == base64:* ]]; then
    encoded_key=${private_key#base64:}
    if [[ -z $encoded_key ]] ||
       ! printf '%s' "$encoded_key" | tr -d '[:space:]' | openssl base64 -d -A > "$key_file"; then
      echo 'AGENT_APP_PRIVATE_KEY base64 decoding failed.' >&2
      return 2
    fi
  else
    if [[ $private_key != *$'\n'* && $private_key == *'\n'* ]]; then
      private_key=${private_key//\\r/}
      private_key=${private_key//\\n/$'\n'}
    fi
    printf '%s\n' "$private_key" > "$key_file"
  fi

  unset private_key encoded_key
  if ! openssl rsa -in "$key_file" -check -noout >/dev/null 2>&1; then
    echo 'AGENT_APP_PRIVATE_KEY is not a valid RSA PEM private key. Store the downloaded .pem file contents, including the BEGIN/END lines, instead of a file path; prefix a base64-encoded PEM with base64:.' >&2
    return 2
  fi
}

create_app_jwt() {
  require_app_commands || return $?

  local app_id=${AGENT_APP_ID:-}
  if [[ -z $app_id || -z ${AGENT_APP_PRIVATE_KEY:-} ]]; then
    return 1
  fi
  if [[ ! $app_id =~ ^[1-9][0-9]*$ ]]; then
    echo 'AGENT_APP_ID must be a positive integer.' >&2
    return 2
  fi

  local key_file
  key_file=$(mktemp)
  chmod 600 "$key_file"
  trap 'rm -f "${key_file:-}"' RETURN
  write_app_private_key "$key_file" || return $?

  local now issued_at expires_at header payload unsigned signature
  now=$(date +%s)
  issued_at=$((now - 60))
  expires_at=$((now + 540))
  header=$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | base64url)
  payload=$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$issued_at" "$expires_at" "$app_id" | base64url)
  unsigned="$header.$payload"
  if ! signature=$(printf '%s' "$unsigned" | openssl dgst -sha256 -sign "$key_file" | base64url); then
    echo 'GitHub App JWT signing failed after private-key validation.' >&2
    return 2
  fi
  if [[ -z $signature ]]; then
    echo 'GitHub App JWT signing produced an empty signature.' >&2
    return 2
  fi
  printf '%s.%s' "$unsigned" "$signature"

  rm -f "$key_file"
  trap - RETURN
}

valid_repository_name() {
  local candidate=${1:-}
  local owner=${candidate%%/*}
  local repo_name=${candidate#*/}
  [[ $candidate =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
  [[ $owner != '.' && $owner != '..' && $repo_name != '.' && $repo_name != '..' ]]
}

repository_contains_checkout_head() {
  local credential=$1
  local candidate=$2
  valid_repository_name "$candidate" || return 1
  curl --fail --silent --location --output /dev/null \
    -H "Authorization: Bearer $credential" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "${api_url}/repos/${candidate}/git/commits/${local_head}" 2>/dev/null
}

resolve_unique_match() {
  local source_name=$1
  shift
  local -a matches=("$@")
  if (( ${#matches[@]} == 1 )); then
    printf '%s' "${matches[0]}"
    return 0
  fi
  if (( ${#matches[@]} > 1 )); then
    echo "GitHub ${source_name} discovery found multiple repositories containing the checkout HEAD; set CODEX_GITHUB_REPOSITORY to disambiguate." >&2
    return 2
  fi
  echo "GitHub ${source_name} discovery found no accessible repository containing the checkout HEAD." >&2
  return 2
}

validate_discovery_limit() {
  local limit=${PRARNESS_GITHUB_DISCOVERY_MAX_REPOSITORIES:-1000}
  if [[ ! $limit =~ ^[1-9][0-9]*$ ]] || (( limit > 5000 )); then
    echo 'PRARNESS_GITHUB_DISCOVERY_MAX_REPOSITORIES must be an integer from 1 through 5000.' >&2
    return 2
  fi
  printf '%s' "$limit"
}

discover_repository_with_token() {
  local token=$1
  local limit
  limit=$(validate_discovery_limit) || return $?
  command -v curl >/dev/null 2>&1 || {
    echo 'GitHub token repository discovery requires curl.' >&2
    return 2
  }
  command -v jq >/dev/null 2>&1 || {
    echo 'GitHub token repository discovery requires jq.' >&2
    return 2
  }

  local page=1 scanned=0 response count candidate existing already_seen
  local -a matches=()
  while (( page <= 100 )); do
    response=$(github_api_get "$token" "${api_url}/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&page=${page}") || {
      echo 'GitHub token repository discovery could not list accessible repositories.' >&2
      return 2
    }
    printf '%s' "$response" | jq -e 'type == "array"' >/dev/null || {
      echo 'GitHub token repository discovery returned an invalid repository list.' >&2
      return 2
    }
    count=$(printf '%s' "$response" | jq 'length')
    while IFS= read -r candidate; do
      [[ -n $candidate ]] || continue
      scanned=$((scanned + 1))
      if (( scanned > limit )); then
        echo "GitHub token repository discovery exceeded its ${limit}-repository safety limit." >&2
        return 2
      fi
      if repository_contains_checkout_head "$token" "$candidate"; then
        already_seen=false
        for existing in "${matches[@]-}"; do
          if [[ $existing == "$candidate" ]]; then
            already_seen=true
            break
          fi
        done
        if [[ $already_seen == false ]]; then
          matches+=("$candidate")
        fi
      fi
    done < <(printf '%s' "$response" | jq -r '.[]?.full_name // empty')
    (( count < 100 )) && break
    page=$((page + 1))
  done
  resolve_unique_match 'token' "${matches[@]-}"
}

discover_repository_with_app() {
  local jwt
  jwt=$(create_app_jwt) || return $?
  local limit
  limit=$(validate_discovery_limit) || return $?

  local configured_installation=${AGENT_APP_INSTALLATION_ID:-}
  local page=1 response count installation_id
  local -a installation_ids=()
  if [[ -n $configured_installation ]]; then
    if [[ ! $configured_installation =~ ^[1-9][0-9]*$ ]]; then
      echo 'AGENT_APP_INSTALLATION_ID must be a positive integer.' >&2
      return 2
    fi
    installation_ids+=("$configured_installation")
  else
    while (( page <= 100 )); do
      response=$(github_api_get "$jwt" "${api_url}/app/installations?per_page=100&page=${page}") || {
        echo 'GitHub App repository discovery could not list App installations.' >&2
        return 2
      }
      printf '%s' "$response" | jq -e 'type == "array"' >/dev/null || {
        echo 'GitHub App repository discovery returned an invalid installation list.' >&2
        return 2
      }
      count=$(printf '%s' "$response" | jq 'length')
      while IFS= read -r installation_id; do
        [[ -n $installation_id ]] && installation_ids+=("$installation_id")
      done < <(printf '%s' "$response" | jq -r '.[].id // empty')
      (( count < 100 )) && break
      page=$((page + 1))
    done
  fi

  if (( ${#installation_ids[@]} == 0 )); then
    echo 'GitHub App repository discovery found no App installations.' >&2
    return 2
  fi

  local discovery_body discovery_response discovery_token candidate existing already_seen scanned=0
  local -a matches=()
  discovery_body=$(jq -cn '{permissions:{contents:"read"}}')
  for installation_id in "${installation_ids[@]}"; do
    discovery_response=$(github_api_post "$jwt" "$discovery_body" "${api_url}/app/installations/${installation_id}/access_tokens") || {
      echo 'GitHub App repository discovery could not create a read-only installation token.' >&2
      return 2
    }
    discovery_token=$(printf '%s' "$discovery_response" | jq -er '.token') || {
      echo 'GitHub App repository discovery received an invalid installation token response.' >&2
      return 2
    }

    page=1
    while (( page <= 100 )); do
      response=$(github_api_get "$discovery_token" "${api_url}/installation/repositories?per_page=100&page=${page}") || {
        echo 'GitHub App repository discovery could not list installation repositories.' >&2
        return 2
      }
      printf '%s' "$response" | jq -e '.repositories | type == "array"' >/dev/null || {
        echo 'GitHub App repository discovery returned an invalid repository list.' >&2
        return 2
      }
      count=$(printf '%s' "$response" | jq '.repositories | length')
      while IFS= read -r candidate; do
        [[ -n $candidate ]] || continue
        scanned=$((scanned + 1))
        if (( scanned > limit )); then
          echo "GitHub App repository discovery exceeded its ${limit}-repository safety limit." >&2
          return 2
        fi
        if repository_contains_checkout_head "$discovery_token" "$candidate"; then
          already_seen=false
          for existing in "${matches[@]-}"; do
            if [[ $existing == "$candidate" ]]; then
              already_seen=true
              break
            fi
          done
          if [[ $already_seen == false ]]; then
            matches+=("$candidate")
          fi
        fi
      done < <(printf '%s' "$response" | jq -r '.repositories[]?.full_name // empty')
      (( count < 100 )) && break
      page=$((page + 1))
    done
    unset discovery_token
  done
  resolve_unique_match 'App' "${matches[@]-}"
}

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
  if valid_repository_name "$candidate"; then
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

  local token=${CODEX_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}
  if [[ -n $token ]]; then
    discover_repository_with_token "$token"
    return $?
  fi

  if [[ -n ${AGENT_APP_ID:-} || -n ${AGENT_APP_PRIVATE_KEY:-} ]]; then
    if [[ -z ${AGENT_APP_ID:-} || -z ${AGENT_APP_PRIVATE_KEY:-} ]]; then
      echo 'GitHub App repository discovery requires both AGENT_APP_ID and AGENT_APP_PRIVATE_KEY.' >&2
      return 2
    fi
    discover_repository_with_app
    return $?
  fi

  echo 'Unable to identify the Cloud checkout. Configure a GitHub token or App credentials; use CODEX_GITHUB_REPOSITORY only to resolve ambiguity.' >&2
  return 2
}

repository=$(detect_repository "${1:-}") || exit $?
if ! valid_repository_name "$repository"; then
  echo 'Codex Cloud GitHub repository must use owner/repository format.' >&2
  exit 2
fi

remote_url="${server_url%/}/${repository}.git"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$remote_url"
else
  git remote add origin "$remote_url"
fi

mint_installation_token() {
  local jwt
  jwt=$(create_app_jwt) || return $?

  local owner=${repository%%/*}
  local repo_name=${repository#*/}
  local installation_id=${AGENT_APP_INSTALLATION_ID:-}
  if [[ -z $installation_id ]]; then
    installation_id=$(github_api_get "$jwt" "${api_url}/repos/${owner}/${repo_name}/installation" | jq -er '.id')
  elif [[ ! $installation_id =~ ^[1-9][0-9]*$ ]]; then
    echo 'AGENT_APP_INSTALLATION_ID must be a positive integer.' >&2
    return 2
  fi

  local request_body response validated_response
  if [[ ${PRARNESS_GITHUB_WORKFLOW_MAINTENANCE:-false} == true ]]; then
    request_body=$(jq -cn --arg repo "$repo_name" '{repositories:[$repo],permissions:{contents:"write",issues:"write",pull_requests:"write",workflows:"write"}}')
  else
    request_body=$(jq -cn --arg repo "$repo_name" '{repositories:[$repo],permissions:{contents:"write",issues:"write",pull_requests:"write"}}')
  fi
  response=$(github_api_post "$jwt" "$request_body" "${api_url}/app/installations/${installation_id}/access_tokens")
  if [[ ${PRARNESS_GITHUB_WORKFLOW_MAINTENANCE:-false} == true ]] &&
     ! printf '%s' "$response" | jq -e '.permissions.workflows == "write"' >/dev/null; then
    echo 'GitHub App installation token is missing required Workflows write permission for interactive workflow maintenance.' >&2
    return 2
  fi
  if ! validated_response=$(printf '%s' "$response" | jq -e '
    select(.token | type == "string" and length > 0) |
    select(.permissions.contents == "write" and .permissions.issues == "write" and .permissions.pull_requests == "write") |
    {token:.token,expires_at:(.expires_at // null),permissions:{contents:.permissions.contents,issues:.permissions.issues,pull_requests:.permissions.pull_requests,workflows:(.permissions.workflows // null)}}'); then
    echo 'GitHub App installation token is missing required Contents, Issues, or Pull requests write permission.' >&2
    return 2
  fi
  printf '%s' "$validated_response"
}

configure_gh_default_repository() {
  local resolution_key
  while IFS= read -r resolution_key; do
    [[ -n $resolution_key ]] || continue
    git config --local --unset-all "$resolution_key" >/dev/null 2>&1 || true
  done < <(git config --local --name-only --get-regexp '^remote\..*\.gh-resolved$' 2>/dev/null || true)
  git config --local --add remote.origin.gh-resolved base
}

config_dir=${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}
auth_metadata_file="$config_dir/prarness-auth.json"

if [[ $mode == configure ]]; then
  token=${CODEX_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}
  expires_at=''
  auth_kind=token
  granted_permissions='{}'
  if [[ -n ${AGENT_APP_ID:-} || -n ${AGENT_APP_PRIVATE_KEY:-} ]]; then
    if [[ -z ${AGENT_APP_ID:-} || -z ${AGENT_APP_PRIVATE_KEY:-} ]]; then
      echo 'GitHub App authentication requires both AGENT_APP_ID and AGENT_APP_PRIVATE_KEY.' >&2
      exit 2
    fi
    credential_response=$(mint_installation_token) || {
      echo 'Configure CODEX_GITHUB_TOKEN or valid AGENT_APP_ID/AGENT_APP_PRIVATE_KEY in the Codex Cloud environment.' >&2
      exit 2
    }
    token=$(printf '%s' "$credential_response" | jq -er '.token')
    expires_at=$(printf '%s' "$credential_response" | jq -r '.expires_at // empty')
    auth_kind=github_app
    granted_permissions=$(printf '%s' "$credential_response" | jq -c '.permissions')
    unset credential_response
  elif [[ -z $token ]]; then
    if ! gh api "repos/$repository" --silent >/dev/null 2>&1; then
      echo 'Configure CODEX_GITHUB_TOKEN or AGENT_APP_ID/AGENT_APP_PRIVATE_KEY in the Codex Cloud environment.' >&2
      exit 2
    fi
    auth_kind=existing
  fi

  if [[ -n $token ]]; then
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
      printf '    users:\n'
      printf '        x-access-token:\n'
      printf '            oauth_token: %s\n' "$token"
    } > "$hosts_tmp"
    mv "$hosts_tmp" "$hosts_file"
  fi
  mkdir -p "$config_dir"
  chmod 700 "$config_dir"
  metadata_tmp=$(mktemp "$config_dir/prarness-auth.json.XXXXXX")
  chmod 600 "$metadata_tmp"
  jq -cn --arg repository "$repository" --arg host "$host" --arg expires_at "$expires_at" \
    --arg auth_kind "$auth_kind" --argjson permissions "$granted_permissions" \
    '{version:1,repository:$repository,host:$host,auth_kind:$auth_kind,expires_at:(if $expires_at == "" then null else $expires_at end),permissions:$permissions}' > "$metadata_tmp"
  mv "$metadata_tmp" "$auth_metadata_file"
  unset token GITHUB_TOKEN GH_TOKEN CODEX_GITHUB_TOKEN AGENT_APP_PRIVATE_KEY
fi

git config --local --unset-all credential."https://${host}".helper >/dev/null 2>&1 || true
git config --local --add credential."https://${host}".helper ''
git config --local --add credential."https://${host}".helper '!gh auth git-credential'
credential_username=x-access-token
if [[ -f $auth_metadata_file ]] && [[ $(jq -r '.auth_kind // "unknown"' "$auth_metadata_file") == existing ]]; then
  credential_username=$(gh api user --jq '.login')
  if [[ ! $credential_username =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$ ]]; then
    echo 'Existing GitHub CLI authentication returned an invalid username.' >&2
    exit 2
  fi
fi
git config --local credential."https://${host}".username "$credential_username"
git config --local user.name "${CODEX_GIT_AUTHOR_NAME:-codex-cloud}"
git config --local user.email "${CODEX_GIT_AUTHOR_EMAIL:-codex-cloud@users.noreply.github.com}"

gh api "repos/$repository" --jq '.full_name' | grep -Fqx "$repository"

credential_file=$(mktemp)
chmod 600 "$credential_file"
cleanup_credential_file() {
  rm -f "$credential_file"
}
trap cleanup_credential_file EXIT
if ! printf 'protocol=https\nhost=%s\n\n' "$host" | GIT_TERMINAL_PROMPT=0 git credential fill > "$credential_file" 2>/dev/null; then
  echo 'Git credential helper could not provide GitHub HTTPS credentials.' >&2
  exit 2
fi
grep -Fqx "username=$credential_username" "$credential_file" && grep -Eq '^password=.+$' "$credential_file" || {
  echo 'Git credential helper returned incomplete GitHub HTTPS credentials.' >&2
  exit 2
}
cleanup_credential_file
trap - EXIT

if [[ -f $auth_metadata_file ]]; then
  metadata_repository=$(jq -er '.repository' "$auth_metadata_file") || exit 2
  metadata_host=$(jq -er '.host' "$auth_metadata_file") || exit 2
  [[ $metadata_repository == "$repository" && $metadata_host == "$host" ]] || {
    echo 'Persisted GitHub authentication metadata does not match this checkout.' >&2
    exit 2
  }
  auth_kind=$(jq -r '.auth_kind // "unknown"' "$auth_metadata_file")
  if [[ $auth_kind == github_app ]]; then
    jq -e '.permissions.contents == "write" and .permissions.issues == "write" and .permissions.pull_requests == "write"' "$auth_metadata_file" >/dev/null || {
      echo 'GitHub App installation token is missing required Contents, Issues, or Pull requests write permission.' >&2
      exit 2
    }
  else
    gh api "repos/$repository" --jq '.permissions.push == true' | grep -Fqx true || {
      echo 'Authenticated user token does not have repository push permission.' >&2
      exit 2
    }
  fi
  expires_at=$(jq -r '.expires_at // empty' "$auth_metadata_file")
  if [[ -n $expires_at ]]; then
    if expires_epoch=$(date -u -d "$expires_at" +%s 2>/dev/null); then
      :
    elif expires_epoch=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$expires_at" +%s 2>/dev/null); then
      :
    else
      echo 'Persisted GitHub credential expiration is invalid.' >&2
      exit 2
    fi
    now_epoch=$(date +%s)
    if (( expires_epoch - now_epoch < 300 )); then
      echo 'Persisted GitHub credential expires too soon for publication; rerun Cloud setup or maintenance.' >&2
      exit 2
    fi
  fi
fi
configure_gh_default_repository
git ls-remote --exit-code origin HEAD >/dev/null

echo "Codex Cloud GitHub write access ready: origin -> $remote_url; gh -> $repository"
