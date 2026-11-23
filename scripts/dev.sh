#!/usr/bin/env bash
# Developer environment for working ON pi-junie with agents (docs/development.md).
# Not needed to USE pi-junie in AIR: for that, `npm ci` and bin/pi-air are enough.
#
#   scripts/dev.sh setup [--no-cezar]   install everything below; safe to run again
#   scripts/dev.sh check                report what is installed; changes nothing
#   scripts/dev.sh worktree [dir]       prepare a task worktree (dependencies + skills); default: current dir
#   scripts/dev.sh cezar [args]         start Cezar's local cockpit (http://127.0.0.1:4321), or run a cezar command
#   scripts/dev.sh audit <spec>         spec audit by a second model, headless Pi (default: Sol)
#   scripts/dev.sh review [spec]        second review of the current branch, headless Pi (default: Opus and Sol)
#   scripts/dev.sh air-test [dir]       put a worktree under test in AIR (the pi-junie-dev agent entry)
#
# What `setup` installs, and where:
#   in the repo, git-ignored   node_modules/ (npm ci)
#                              .agents/skills/om-*   upstream skills at the commit in skills-lock.json
#                              .agents/skills/agent-* links to your own review skills in ~/.claude/skills, if present
#                              .claude/skills/       links, so Claude Code sees the same skills as Pi
#                              .dev-tools/           Cezar, at the version below
#   outside the repo           nothing. Tools started later write their own state:
#                              ~/.cezar (Cezar), ~/.pi/pi-junie-dev (headless Pi), ~/.local/state/pi-junie (air-test link)
# Network: npm registry and github.com/open-mercato/skills. Telemetry of both tools is switched off here.
#
# Settings: PI_JUNIE_ENV (key file, default ~/.config/pi-junie/env), PI_REVIEW_MODELS, PI_AUDIT_MODEL.
set -euo pipefail

CEZAR_VERSION="0.20.0"
SKILLS_CLI="skills@1.9.0"
REVIEW_MODELS="${PI_REVIEW_MODELS:-jetbrains-ai/claude-opus-5-5 jetbrains-ai/gpt-6.1-sol}"
AUDIT_MODEL="${PI_AUDIT_MODEL:-jetbrains-ai/gpt-6.1-sol}"
OWN_REVIEW_SKILLS="agent-cross-review agent-review agent-overview agent-notes"
PI_TIMEOUT="${PI_TIMEOUT:-1800}"   # seconds for one headless Pi report
READ_ONLY_TOOLS="read,grep,find,ls,bash"

HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
MAIN="$(dirname "$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir)")"
ENV_FILE="${PI_JUNIE_ENV:-$HOME/.config/pi-junie/env}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pi-junie"
export DO_NOT_TRACK=1 DISABLE_TELEMETRY=1 CEZ_TELEMETRY=0

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok       %s\n' "$*"; }
miss() { printf '  MISSING  %s\n' "$*"; MISSING=$((MISSING + 1)); }
note() { printf '  note     %s\n' "$*"; }
die()  { printf 'dev.sh: %s\n' "$*" >&2; exit 1; }
MISSING=0

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)'
}

# Link every skill of $1/.agents/skills into $1/.claude/skills, so Claude Code sees what Pi sees.
link_claude_skills() {
  local root="$1" d name
  mkdir -p "$root/.claude/skills"
  for d in "$root"/.agents/skills/*/; do
    [[ -f "$d/SKILL.md" ]] || continue
    name="$(basename "$d")"
    [[ -e "$root/.claude/skills/$name" || -L "$root/.claude/skills/$name" ]] && continue
    ln -s "../../.agents/skills/$name" "$root/.claude/skills/$name"
  done
}

# Link the user's own review skills (they read each other's files, so the whole family is needed).
link_own_review_skills() {
  local root="$1" s src
  for s in $OWN_REVIEW_SKILLS; do
    src="$HOME/.claude/skills/$s"
    [[ -f "$src/SKILL.md" ]] || continue
    [[ -e "$root/.agents/skills/$s" || -L "$root/.agents/skills/$s" ]] && continue
    ln -s "$src" "$root/.agents/skills/$s"
  done
}

cmd_check() {
  say "pi-junie developer environment: $MAIN"
  if node_ok; then ok "node $(node --version)"; else miss "node >= 22.19"; fi
  for t in git jq; do command -v "$t" >/dev/null 2>&1 && ok "$t" || miss "$t"; done
  for t in claude gg; do command -v "$t" >/dev/null 2>&1 && ok "$t" || note "$t not found (needed for the Claude Code + gg route only)"; done
  [[ -x "$MAIN/node_modules/.bin/pi" ]] && ok "dependencies (Pi $("$MAIN/node_modules/.bin/pi" --version 2>/dev/null))" || miss "dependencies: npm ci"
  local s
  for s in $(jq -r '.skills | keys[]' "$MAIN/skills-lock.json"); do
    [[ -f "$MAIN/.agents/skills/$s/SKILL.md" ]] && ok "skill $s" || miss "skill $s"
  done
  for s in new-feature plugin-check air-test-handoff; do
    [[ -e "$MAIN/.claude/skills/$s/SKILL.md" ]] && ok "skill $s (project, linked for Claude Code)" || miss "Claude Code link for skill $s"
  done
  for s in $OWN_REVIEW_SKILLS; do
    [[ -f "$MAIN/.agents/skills/$s/SKILL.md" ]] && ok "skill $s (yours)" || note "skill $s not in ~/.claude/skills: cross-review inside AIR is unavailable"
  done
  [[ -x "$MAIN/.dev-tools/node_modules/.bin/cezar" ]] && ok "Cezar $(jq -r .version "$MAIN/.dev-tools/node_modules/@open-mercato/cezar/package.json")" || note "Cezar not installed (setup --no-cezar, or not set up yet)"
  if [[ -r "$ENV_FILE" ]] && grep -q '^JUNIE_API_KEY=.' "$ENV_FILE"; then ok "JetBrains AI key file $ENV_FILE"
  else note "no JUNIE_API_KEY in $ENV_FILE: headless Pi (audit, review, Cezar's Pi steps) needs it or a saved /login"; fi
  [[ -L "$STATE_DIR/under-test" ]] && note "under test in AIR: $(readlink "$STATE_DIR/under-test")"
  if [[ "$MISSING" -gt 0 ]]; then say "$MISSING missing. Run: scripts/dev.sh setup"; return 1; fi
  say "Ready."
}

cmd_setup() {
  local cezar=1
  [[ "${1:-}" == "--no-cezar" ]] && cezar=0
  [[ "$HERE" == "$MAIN" ]] || die "run setup in the main checkout ($MAIN); in a task worktree use: scripts/dev.sh worktree"
  node_ok || die "node >= 22.19 is required"
  for t in git jq npm npx; do command -v "$t" >/dev/null 2>&1 || die "$t is required"; done
  cd "$MAIN"

  say "1/4 dependencies"
  [[ -x node_modules/.bin/pi ]] || npm ci --no-audit --no-fund --loglevel=error >/dev/null

  say "2/4 upstream skills (commit pinned in skills-lock.json)"
  local need=0 s
  for s in $(jq -r '.skills | keys[]' skills-lock.json); do [[ -f ".agents/skills/$s/SKILL.md" ]] || need=1; done
  if [[ "$need" == 1 ]]; then
    # The installer downloads from GitHub and sometimes fails halfway; a second run finishes the rest.
    local log try
    log="$(mktemp)"
    for try in 1 2 3; do
      npx --yes "$SKILLS_CLI" experimental_install --agent claude-code --agent pi --frozen-lockfile --yes >"$log" 2>&1 && break
      [[ "$try" == 3 ]] && { cat "$log" >&2; rm -f "$log"; die "installing the upstream skills failed"; }
      say "  retrying ($try)"
    done
    rm -f "$log"
  fi

  say "3/4 skill links"
  link_own_review_skills "$MAIN"
  link_claude_skills "$MAIN"

  if [[ "$cezar" == 1 ]]; then
    say "4/4 Cezar $CEZAR_VERSION into .dev-tools/"
    if [[ "$(jq -r .version .dev-tools/node_modules/@open-mercato/cezar/package.json 2>/dev/null)" != "$CEZAR_VERSION" ]]; then
      npm install --prefix .dev-tools --no-audit --no-fund --no-package-lock --loglevel=error "@open-mercato/cezar@$CEZAR_VERSION" >/dev/null
    fi
  else
    say "4/4 Cezar skipped"
  fi
  say
  cmd_check
}

cmd_worktree() {
  local wt
  wt="$(cd "${1:-.}" && git rev-parse --show-toplevel)"
  [[ "$wt" != "$MAIN" ]] || die "$wt is the main checkout; use: scripts/dev.sh setup"
  [[ "$(dirname "$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)")" == "$MAIN" ]] || die "$wt is not a worktree of $MAIN"
  [[ -x "$wt/node_modules/.bin/vitest" ]] || (cd "$wt" && npm ci --prefer-offline --no-audit --no-fund --loglevel=error >/dev/null)
  # Git-ignored skills exist only in the main checkout: link them, do not download them again.
  local d name
  mkdir -p "$wt/.agents/skills"
  for d in "$MAIN"/.agents/skills/*/; do
    name="$(basename "$d")"
    [[ -e "$wt/.agents/skills/$name" || -L "$wt/.agents/skills/$name" ]] && continue
    ln -s "$(readlink -f "$d")" "$wt/.agents/skills/$name"
  done
  link_claude_skills "$wt"
  say "worktree ready: $wt"
}

cmd_cezar() {
  local bin="$MAIN/.dev-tools/node_modules/.bin/cezar"
  [[ -x "$bin" ]] || die "Cezar is not installed; run: scripts/dev.sh setup"
  # Pi steps run plain Pi on JetBrains AI. The key stays in the wrapper, so Claude steps and checks never see it.
  export CEZ_PI_BIN="$MAIN/scripts/pi-jbai"
  export CEZ_REVIEW_GATE="${CEZ_REVIEW_GATE:-1}" CEZ_NO_BANNER=1 CEZ_SKILLS_AUTO_UPDATE=0
  cd "$MAIN"
  exec "$bin" "$@"
}

# Run one headless, read-only Pi turn with a skill and save its answer.
pi_report() { # model skill prompt outfile
  local model="$1" skill="$2" prompt="$3" out="$4" dir
  dir="$(git rev-parse --show-toplevel)"
  [[ -f "$dir/.agents/skills/$skill/SKILL.md" ]] || die "skill $skill is missing in $dir; run: scripts/dev.sh worktree"
  mkdir -p "$(dirname "$out")"
  say "  $model -> ${out#"$dir"/}"
  # stdin from /dev/null: with an open, non-terminal stdin, `pi --print` waits for it to end.
  timeout "$PI_TIMEOUT" "$MAIN/scripts/pi-jbai" --print --no-session --model "$model" --tools "$READ_ONLY_TOOLS" \
    --skill "$dir/.agents/skills/$skill" "$prompt" </dev/null >"$out" 2>"$out.log" \
    || { say "  FAILED or timed out after ${PI_TIMEOUT}s, see $out.log"; return 1; }
  [[ -s "$out" ]] || { say "  EMPTY report, see $out.log"; return 1; }
  rm -f "$out.log"
}

cmd_audit() {
  local spec="${1:-}" dir
  [[ -f "$spec" ]] || die "usage: scripts/dev.sh audit <spec file>"
  dir="$(git rev-parse --show-toplevel)"
  say "spec audit of $spec"
  pi_report "$AUDIT_MODEL" om-pre-implement-spec \
    "Use the om-pre-implement-spec skill on the spec at $spec. Report only: change, commit and stash nothing. Give the full report as your answer." \
    "$dir/.ai/reviews/$(basename "$spec" .md).audit.md"
}

cmd_review() {
  local spec="${1:-}" dir branch m fail=0 against=""
  dir="$(git rev-parse --show-toplevel)"
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [[ "$branch" != "main" ]] || die "you are on main; run the review in the branch's worktree"
  [[ -z "$spec" || -f "$spec" ]] || die "spec not found: $spec"
  [[ -n "$spec" ]] && against=" and against the spec at $spec"
  say "second review of $branch (report only)"
  for m in $REVIEW_MODELS; do
    pi_report "$m" om-code-review \
      "Use the om-code-review skill. Review this branch against main$against. Report only: change, commit and stash nothing. Give the full report as your answer." \
      "$dir/.ai/reviews/${branch//\//-}.$(basename "$m").md" || fail=1
  done
  return "$fail"
}

cmd_air_test() {
  local wt prev=""
  wt="$(cd "${1:-.}" && git rev-parse --show-toplevel)"
  [[ -x "$wt/bin/pi-air" ]] || die "$wt has no bin/pi-air"
  [[ -x "$wt/node_modules/.bin/vitest" ]] || die "$wt has no dependencies; run: scripts/dev.sh worktree $wt"
  mkdir -p "$STATE_DIR"
  [[ -L "$STATE_DIR/under-test" ]] && prev="$(readlink "$STATE_DIR/under-test")"
  ln -sfn "$wt" "$STATE_DIR/under-test"
  [[ -n "$prev" && "$prev" != "$wt" ]] && say "replaced: $prev"
  say "under test: $wt"
  say "log:        $wt/.pi-dev/pi-air.log"
  say
  say "AIR agent entry (once, in ~/.jetbrains/acp.json next to \"pi-junie\"); then start a NEW chat with pi-junie-dev:"
  say "  \"pi-junie-dev\": { \"command\": \"$STATE_DIR/under-test/bin/pi-air\", \"args\": [], \"env\": {} }"
}

case "${1:-help}" in
  setup)    shift; cmd_setup "$@" ;;
  check)    cmd_check ;;
  worktree) shift; cmd_worktree "$@" ;;
  cezar)    shift; cmd_cezar "$@" ;;
  audit)    shift; cmd_audit "$@" ;;
  review)   shift; cmd_review "$@" ;;
  air-test) shift; cmd_air_test "$@" ;;
  *)        sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
