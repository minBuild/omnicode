#!/usr/bin/env bash
# mcp-feature.sh — OmniCode installer fragment for the MCP management feature (design 17.6, steps 1-8).
#
# Idempotent: every step checks before it changes anything, so it can be re-run after a partial
# failure or after pulling a new version of the repo. Targets Ubuntu 22.04+/24.04 (apt) and
# Amazon Linux 2023 (dnf). Run as root from the checkout that is (or will be) built at /opt/omnicode:
#
#   sudo bash infra/install/mcp-feature.sh [--public-url https://host] [--backup-bucket name[/prefix]]
#                                          [--start] [--skip-aws] [--help]
#
# Sourcing the file (`. infra/install/mcp-feature.sh`) only defines the functions; main runs only when
# the file is executed directly.
#
# Steps (one function each, see main):
#   1. users: omnicode (system, nologin, home /var/lib/omnicode), omniagent (bash, /home/omniagent 0700)
#   2. directories with the ownership/modes of design 8.2; /etc/omnicode/omnicode.env from .env.example
#      (created once, never overwritten; --public-url / --backup-bucket set single keys)
#   3. systemd units (incl. omnicode-agentd.socket) + /usr/local/sbin scripts + omnicode-hub-headers; enable units;
#      iptables rules are persisted by omnicode-imds-guard.service
#   4. aws ec2 modify-instance-metadata-options --http-tokens required --http-put-response-hop-limit 1
#   5. IAM instance role policy: printed (cannot be attached from inside the instance)
#   6. initial agent tokens: created automatically by omnicode.service on first start (10.5); printed how to verify
#   7. CloudFront public paths: printed (infra/cloudfront/README.md)
#   8. omniagent shell profiles source ~/.omnicode/env.sh
# Step 9 (Docker for stdio servers) is Phase 2 and not handled here.
#
# Safety: the env file is parsed, never sourced; values from flags are validated before they are
# written; nothing is eval'ed.
set -euo pipefail

# --- settings (override through the environment) ----------------------------------------------
: "${OMNICODE_REPO_DIR:=/opt/omnicode}"        # where the units expect the built code
: "${OMNICODE_ENV_FILE:=/etc/omnicode/omnicode.env}"
: "${OMNICODE_DATA_DIR:=/var/lib/omnicode}"
: "${OMNIAGENT_HOME:=/home/omniagent}"
: "${SYSTEMD_UNIT_DIR:=/etc/systemd/system}"
: "${TMPFILES_DIR:=/etc/tmpfiles.d}"           # only to remove the pre-socket-activation omnicode.conf
: "${OMNICODE_RUN_DIR:=/run/omnicode}"        # agentd socket directory, created by omnicode-agentd.socket
: "${SBIN_DIR:=/usr/local/sbin}"
: "${BIN_DIR:=/usr/local/bin}"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # this checkout
SKIP_AWS=0
START_SERVICES=0
PUBLIC_URL=""
BACKUP_BUCKET=""
# shellcheck disable=SC2016  # $HOME must stay literal: the line is written into omniagent's shell profiles
ENV_SOURCE_LINE='[ -f "$HOME/.omnicode/env.sh" ] && . "$HOME/.omnicode/env.sh"'
UNITS=(omnicode.service omnicode-agentd.socket omnicode-agentd.service omnicode-imds-guard.service omnicode-backup.service omnicode-backup.timer)

log()  { printf '[mcp-feature] %s\n' "$*"; }
warn() { printf '[mcp-feature] WARNING: %s\n' "$*" >&2; }
die()  { printf '[mcp-feature] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
}

# --- 0. packages --------------------------------------------------------------------------------
pkg_manager() {
  if command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf >/dev/null 2>&1; then echo dnf
  elif command -v yum >/dev/null 2>&1; then echo yum
  else echo none
  fi
}

ensure_packages() {
  local missing=() names=() m
  { command -v iptables && command -v ip6tables; } >/dev/null 2>&1 || missing+=(iptables)
  command -v sqlite3 >/dev/null 2>&1 || missing+=(sqlite3)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  if ((${#missing[@]} > 0)); then
    case "$(pkg_manager)" in
      apt)
        DEBIAN_FRONTEND=noninteractive apt-get update -q
        DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${missing[@]}"
        ;;
      dnf|yum)
        for m in "${missing[@]}"; do
          case "$m" in
            iptables) names+=(iptables-nft) ;;
            sqlite3) names+=(sqlite) ;;
            *) names+=("$m") ;;
          esac
        done
        "$(pkg_manager)" install -y -q "${names[@]}"
        ;;
      *) die "cannot install ${missing[*]}: no apt-get/dnf/yum found" ;;
    esac
    log "packages: installed ${missing[*]}"
  else
    log "packages: ok"
  fi
  command -v aws  >/dev/null 2>&1 || warn "aws CLI not found: backups and the IMDS step need it"
  command -v node >/dev/null 2>&1 || warn "node not found: the units run /usr/bin/node"
}

# --- 1. users -----------------------------------------------------------------------------------
nologin_shell() {
  command -v nologin 2>/dev/null && return 0
  [ -x /usr/sbin/nologin ] && { echo /usr/sbin/nologin; return 0; }
  echo /sbin/nologin
}

ensure_users() {
  getent group omnicode >/dev/null || { groupadd --system omnicode; log "group omnicode: created"; }
  if id -u omnicode >/dev/null 2>&1; then
    log "user omnicode: exists"
  else
    useradd --system --gid omnicode --home-dir "$OMNICODE_DATA_DIR" --no-create-home \
      --shell "$(nologin_shell)" --comment "OmniCode API and Hub" omnicode
    log "user omnicode: created"
  fi

  getent group omniagent >/dev/null || { groupadd omniagent; log "group omniagent: created"; }
  if id -u omniagent >/dev/null 2>&1; then
    log "user omniagent: exists"
  else
    useradd --gid omniagent --home-dir "$OMNIAGENT_HOME" --create-home --shell /bin/bash \
      --comment "OmniCode agent CLIs" omniagent
    log "user omniagent: created"
  fi

  # omniagent must never be in group omnicode: it would be able to read /etc/omnicode/omnicode.env.
  if id -nG omniagent | tr ' ' '\n' | grep -qx omnicode; then
    gpasswd -d omniagent omnicode >/dev/null
    warn "removed omniagent from group omnicode (trust boundary, design 7.1)"
  fi
}

# --- 2. directories and env file ----------------------------------------------------------------
ensure_dir() {   # ensure_dir <path> <mode> <owner> <group>
  local p="$1" mode="$2" owner="$3" group="$4"
  [ -d "$p" ] || mkdir -p "$p"
  chown "$owner:$group" "$p"
  chmod "$mode" "$p"
}

ensure_dirs() {
  ensure_dir "$OMNICODE_DATA_DIR"              0700 omnicode  omnicode
  ensure_dir "$OMNICODE_DATA_DIR/backup"       0700 omnicode  omnicode
  ensure_dir "$(dirname "$OMNICODE_ENV_FILE")" 0750 root      omnicode
  ensure_dir "$OMNIAGENT_HOME"                 0700 omniagent omniagent
  ensure_dir "$OMNIAGENT_HOME/.omnicode"       0700 omniagent omniagent
  ensure_dir "$OMNIAGENT_HOME/.omnicode/tokens" 0700 omniagent omniagent
  log "directories: ok (8.2)"
}

# set_env_key <KEY> <VALUE>: replace the (possibly commented-out) KEY= line or append it.
# VALUE must already be validated by the caller (no newlines or backslashes).
set_env_key() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    {
      line = $0
      sub(/^[ \t]*#?[ \t]*/, "", line)
      if (!done && index(line, k "=") == 1) { print k "=" v; done = 1; next }
      print
    }
    END { if (!done) print k "=" v }
  ' "$OMNICODE_ENV_FILE" > "$tmp"
  install -m 0640 -o root -g omnicode "$tmp" "$OMNICODE_ENV_FILE"
  rm -f "$tmp"
  log "env file: set $key"
}

ensure_env_file() {
  if [ -f "$OMNICODE_ENV_FILE" ]; then
    log "env file: $OMNICODE_ENV_FILE exists (left untouched)"
  else
    [ -f "$SRC_DIR/.env.example" ] || die "missing $SRC_DIR/.env.example"
    install -m 0640 -o root -g omnicode "$SRC_DIR/.env.example" "$OMNICODE_ENV_FILE"
    log "env file: created $OMNICODE_ENV_FILE from .env.example"
  fi
  chown root:omnicode "$OMNICODE_ENV_FILE"
  chmod 0640 "$OMNICODE_ENV_FILE"
  if [ -n "$PUBLIC_URL" ]; then set_env_key OMNICODE_PUBLIC_URL "$PUBLIC_URL"; fi
  if [ -n "$BACKUP_BUCKET" ]; then set_env_key OMNICODE_BACKUP_BUCKET "$BACKUP_BUCKET"; fi
}

# --- 3. files, units, services ------------------------------------------------------------------
install_file() {   # install_file <src> <dest> <mode> [owner] [group]
  local src="$1" dest="$2" mode="$3" owner="${4:-root}" group="${5:-root}"
  [ -f "$src" ] || die "missing source file $src"
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    chown "$owner:$group" "$dest"
    chmod "$mode" "$dest"
    log "install: $dest unchanged"
  else
    install -m "$mode" -o "$owner" -g "$group" "$src" "$dest"
    log "install: $dest updated"
  fi
}

install_files() {
  local u
  for u in "${UNITS[@]}"; do
    install_file "$SRC_DIR/infra/systemd/$u" "$SYSTEMD_UNIT_DIR/$u" 0644
  done
  install_file "$SRC_DIR/infra/bin/omnicode-imds-guard" "$SBIN_DIR/omnicode-imds-guard" 0755
  install_file "$SRC_DIR/infra/bin/omnicode-backup" "$SBIN_DIR/omnicode-backup" 0755
  install_file "$SRC_DIR/packages/tools/bin/omnicode-hub-headers" "$BIN_DIR/omnicode-hub-headers" 0755
  retire_agentd_runtime_dir
  systemctl daemon-reload
}

# The agentd socket and its directory now come from omnicode-agentd.socket (socket activation, D7/P10):
# /run/omnicode root:root 0755 (DirectoryMode=), agentd.sock omniagent:omnicode 0660. Undo what earlier
# versions set up: the tmpfiles entry, and the omniagent:omniagent 0750 directory left by RuntimeDirectory=,
# which omnicode.service can no longer traverse now that it has no SupplementaryGroups=omniagent.
retire_agentd_runtime_dir() {
  if [ -e "$TMPFILES_DIR/omnicode.conf" ]; then
    rm -f "$TMPFILES_DIR/omnicode.conf"
    log "tmpfiles: removed $TMPFILES_DIR/omnicode.conf (omnicode-agentd.socket creates $OMNICODE_RUN_DIR)"
  fi
  if [ -d "$OMNICODE_RUN_DIR" ]; then
    chown root:root "$OMNICODE_RUN_DIR"
    chmod 0755 "$OMNICODE_RUN_DIR"
  fi
}

# A daemon started before socket activation created the socket itself and unlinks that path when it exits,
# so it must be stopped before omnicode-agentd.socket binds the same path.
start_agentd_socket() {
  if systemctl is-active --quiet omnicode-agentd.socket; then
    log "agentd socket: active"
    return
  fi
  if systemctl is-active --quiet omnicode-agentd.service; then
    systemctl stop omnicode-agentd.service
    log "agentd: stopped the daemon that predates socket activation"
  fi
  systemctl start omnicode-agentd.socket
  log "agentd socket: started ($OMNICODE_RUN_DIR/agentd.sock, omniagent:omnicode 0660)"
}

enable_services() {
  systemctl enable "${UNITS[@]}"
  # Apply the iptables rules now; the unit keeps them across reboots. Running the script directly is
  # idempotent and does not restart dependents the way `systemctl restart` would (Requires=).
  systemctl start omnicode-imds-guard.service
  "$SBIN_DIR/omnicode-imds-guard"
  systemctl start omnicode-backup.timer
  if [ "$START_SERVICES" = 1 ]; then
    [ -f "$OMNICODE_REPO_DIR/packages/agentd/dist/main.js" ] && [ -f "$OMNICODE_REPO_DIR/packages/api/dist/main.js" ] \
      || die "--start: build output not found under $OMNICODE_REPO_DIR (run: npm ci && npm run build)"
    start_agentd_socket
    systemctl restart omnicode-agentd.service omnicode.service
    log "services: omnicode-agentd and omnicode (re)started"
  else
    log "services: enabled, not started (build first, then re-run with --start; or: systemctl stop omnicode-agentd && systemctl restart omnicode-agentd.socket omnicode-agentd omnicode)"
  fi
}

# --- 4. IMDSv2 ----------------------------------------------------------------------------------
imds_get() {   # imds_get <meta-data path>
  local token
  token="$(curl -sS -m 3 -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null)" || return 1
  curl -sS -m 3 -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1" 2>/dev/null
}

configure_imds() {
  local instance_id region
  if [ "$SKIP_AWS" = 1 ]; then log "IMDS: skipped (--skip-aws)"; return; fi
  if ! command -v aws >/dev/null 2>&1; then
    warn "IMDS: aws CLI missing. Run: aws ec2 modify-instance-metadata-options --instance-id <id> --http-tokens required --http-put-response-hop-limit 1"
    return
  fi
  instance_id="$(imds_get instance-id || true)"
  region="$(imds_get placement/region || true)"
  if ! [[ "$instance_id" =~ ^i-[0-9a-f]{8,17}$ ]]; then
    warn "IMDS: metadata unreachable or not an EC2 instance; skipping modify-instance-metadata-options"
    return
  fi
  [[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || die "IMDS: unexpected region value '$region'"
  aws ec2 modify-instance-metadata-options --region "$region" --instance-id "$instance_id" \
    --http-tokens required --http-put-response-hop-limit 1 --output text >/dev/null
  log "IMDS: $instance_id ($region) -> HttpTokens=required, HttpPutResponseHopLimit=1"
}

# --- 8. shell profiles --------------------------------------------------------------------------
append_line_once() {   # append_line_once <file> <line> <owner> <group>
  local file="$1" line="$2" owner="$3" group="$4"
  if [ -f "$file" ] && grep -qxF -- "$line" "$file"; then
    log "profile: $file already sources env.sh"
    return
  fi
  local needs_newline=0
  if [ -s "$file" ] && [ "$(tail -c 1 "$file")" != "" ]; then needs_newline=1; fi
  {
    if [ "$needs_newline" = 1 ]; then printf '\n'; fi
    printf '# OmniCode: agent tokens for interactive shells (design 12.6)\n%s\n' "$line"
  } >> "$file"
  chown "$owner:$group" "$file"
  log "profile: added env.sh source line to $file"
}

configure_shell_profiles() {
  append_line_once "$OMNIAGENT_HOME/.bashrc" "$ENV_SOURCE_LINE" omniagent omniagent
  append_line_once "$OMNIAGENT_HOME/.zshrc"  "$ENV_SOURCE_LINE" omniagent omniagent
}

# --- 5/6/7. things that happen outside this instance ----------------------------------------------
print_next_steps() {
  cat <<'EOS'

================================================================================
Next steps (design 17.6)
================================================================================
5. IAM instance role — attach infra/aws/iam-policy.json after replacing the bucket placeholder:
     sed 's#__OMNICODE_BACKUP_BUCKET__#<backup-bucket>#g' infra/aws/iam-policy.json > /tmp/omnicode-iam.json
     aws iam put-role-policy --role-name <instance-role> --policy-name omnicode-mcp \
       --policy-document file:///tmp/omnicode-iam.json

6. Agent tokens — nothing to run. omnicode.service creates the three agent tokens on its first start,
   stores them in Secrets Manager (<prefix>/hub-tokens) and hands copies to agentd, which writes
   /home/omniagent/.omnicode/tokens/{claude,codex,gemini} (0600). Verify after the service is up:
     sudo -u omniagent ls -l /home/omniagent/.omnicode/tokens
   Rotate later from the web UI (Hub 상태 → Hub 토큰 재발급).

7. CloudFront — add two public behaviors in front of the login wall (infra/cloudfront/README.md):
     /.well-known/omnicode/client.json   cache 1 hour (origin sends Cache-Control: public, max-age=3600)
     /oauth/callback                     no cache, forward ALL query strings, must bypass the login function

Then:
     edit /etc/omnicode/omnicode.env            (OMNICODE_PUBLIC_URL, OMNICODE_BACKUP_BUCKET, ...)
     systemctl restart omnicode-agentd omnicode
     curl -s http://127.0.0.1:7410/healthz
     sudo -u omniagent curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token ; echo "exit=$? (must be non-zero, P9)"
EOS
}

# --- main ---------------------------------------------------------------------------------------
parse_args() {
  while (($# > 0)); do
    case "$1" in
      --public-url)
        [ $# -ge 2 ] || die "--public-url needs a value"
        PUBLIC_URL="$2"
        [[ "$PUBLIC_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "--public-url must be https://host[:port] without a path"
        shift 2 ;;
      --backup-bucket)
        [ $# -ge 2 ] || die "--backup-bucket needs a value"
        BACKUP_BUCKET="$2"
        [[ "$BACKUP_BUCKET" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || die "--backup-bucket must be 'bucket' or 'bucket/prefix'"
        shift 2 ;;
      --start) START_SERVICES=1; shift ;;
      --skip-aws) SKIP_AWS=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "unknown argument: $1" ;;
    esac
  done
}

main() {
  parse_args "$@"
  require_root
  [ "$SRC_DIR" = "$OMNICODE_REPO_DIR" ] || warn "running from $SRC_DIR; the units expect the build at $OMNICODE_REPO_DIR"
  ensure_packages
  ensure_users
  ensure_dirs
  ensure_env_file
  install_files
  enable_services
  configure_imds
  configure_shell_profiles
  print_next_steps
  log "done"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
