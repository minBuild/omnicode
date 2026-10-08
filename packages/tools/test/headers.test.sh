#!/usr/bin/env bash
# Tests for bin/omnicode-hub-headers (design 12.3).
# Usage: bash packages/tools/test/headers.test.sh   (or: npm test --workspace @omnicode/tools)
# Runs the helper under a temporary HOME with a scrubbed environment and checks stdout + exit status.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="$here/../bin/omnicode-hub-headers"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

token_dir="$tmp/.omnicode/tokens"
token_file="$token_dir/claude"
valid_token="omh_0123456789abcdefghijklmnopqrstuvwxyzABCDE-_"   # omh_ + 43 chars, 47 total (10.5)

fails=0
pass() { printf 'ok   - %s\n' "$1"; }
fail() { printf 'FAIL - %s\n' "$1"; fails=$((fails + 1)); }

write_token() {   # write_token <content> (written verbatim, no newline added)
  mkdir -p "$token_dir"
  printf '%s' "$1" > "$token_file"
  chmod 0600 "$token_file"
}

# run <name> <expected-exit> <expected-stdout> [VAR=value ...]
# The helper is invoked through sh with only HOME, PATH and the given variables in its environment.
run() {
  local name="$1" want_rc="$2" want_out="$3"
  shift 3
  local out rc=0
  out="$(env -i HOME="$tmp" PATH="$PATH" "$@" sh "$helper" 2>"$tmp/stderr")" || rc=$?
  if [[ "$rc" == "$want_rc" && "$out" == "$want_out" ]]; then
    pass "$name"
  else
    fail "$name: exit=$rc (want $want_rc) stdout=$out (want $want_out)"
  fi
  if [[ -s "$tmp/stderr" ]]; then
    fail "$name: wrote to stderr: $(cat "$tmp/stderr")"
  fi
}

# --- file properties -------------------------------------------------------
if [[ -x "$helper" ]]; then pass "helper is executable"; else fail "helper is not executable (chmod +x)"; fi
if [[ "$(head -n 1 "$helper")" == '#!/bin/sh' ]]; then pass "helper shebang is #!/bin/sh"; else fail "helper shebang is not #!/bin/sh"; fi
if sh -n "$helper"; then pass "helper passes sh -n"; else fail "helper fails sh -n"; fi

# --- valid token -----------------------------------------------------------
write_token "$valid_token"
run "valid token, no job id" 0 \
  "{\"Authorization\":\"Bearer $valid_token\",\"X-OmniCode-Job\":\"\"}"
run "valid token, empty job id" 0 \
  "{\"Authorization\":\"Bearer $valid_token\",\"X-OmniCode-Job\":\"\"}" OMNICODE_JOB_ID=
run "valid token, job id" 0 \
  "{\"Authorization\":\"Bearer $valid_token\",\"X-OmniCode-Job\":\"job-42_A\"}" OMNICODE_JOB_ID=job-42_A
run "valid token, job id with bad chars is blanked" 0 \
  "{\"Authorization\":\"Bearer $valid_token\",\"X-OmniCode-Job\":\"\"}" 'OMNICODE_JOB_ID=bad job;id'
run "valid token, job id with quote is blanked" 0 \
  "{\"Authorization\":\"Bearer $valid_token\",\"X-OmniCode-Job\":\"\"}" 'OMNICODE_JOB_ID=x"y'

write_token "$valid_token"$'\n'
run "valid token with trailing newline" 0 \
  "{\"Authorization\":\"Bearer $valid_token\",\"X-OmniCode-Job\":\"\"}"

write_token "omh_a"
run "shortest token form (prefix + one char)" 0 \
  "{\"Authorization\":\"Bearer omh_a\",\"X-OmniCode-Job\":\"\"}"

# --- bad token -------------------------------------------------------------
write_token "abc_0123456789abcdefghijklmnopqrstuvwxyzABCDE-_"
run "token without omh_ prefix" 1 "{}"
# shellcheck disable=SC2016  # a literal $ in the token is the point of this case
write_token 'omh_abc$def'
run "token with bad charset" 1 "{}" OMNICODE_JOB_ID=job-1
write_token 'omh_abc"def'
run "token with quote" 1 "{}"
write_token "omh_"
run "prefix only" 1 "{}"
write_token ""
run "empty token file" 1 "{}"
write_token "$valid_token"$'\n'"omh_second"
run "token file with two lines" 1 "{}"
write_token "OMH_ABC"
run "uppercase prefix" 1 "{}"
write_token " $valid_token"
run "leading space" 1 "{}"

rm -f "$token_file"
run "missing token file" 1 "{}"
rm -rf "$tmp/.omnicode"
run "missing token directory" 1 "{}"

# --- environment -----------------------------------------------------------
write_token "$valid_token"
out="$(env -i PATH="$PATH" sh "$helper" 2>/dev/null)" && rc=0 || rc=$?
if [[ "$rc" == 1 && "$out" == "{}" ]]; then pass "unset HOME"; else fail "unset HOME: exit=$rc stdout=$out"; fi

# --- summary ---------------------------------------------------------------
if (( fails > 0 )); then
  printf '\n%d test(s) FAILED\n' "$fails"
  exit 1
fi
printf '\nall headers tests passed\n'
