#!/usr/bin/env bash
# Developer environment for working ON pi-junie with agents (docs/development.md).
# Not needed to USE pi-junie in AIR: for that, `npm ci` and bin/pi-air are enough.
#
#   scripts/dev.sh setup                install everything below; safe to run again
#   scripts/dev.sh check                report what is installed; changes nothing
#   scripts/dev.sh agent [update [ref]] the development agent (what scripts/pi-jbai runs): show it, or move it to main / a commit
#   scripts/dev.sh worktree [dir]       prepare a task worktree (dependencies + skills); default: current dir
#   scripts/dev.sh cezar [args]         start Cezar's local cockpit (http://127.0.0.1:4321), or run a cezar command
#   scripts/dev.sh audit <spec>         spec audit by a second model, headless Pi (default: Sol)
#   scripts/dev.sh review [spec]        second review of the current branch, headless Pi (default: Opus and Sol)
#   scripts/dev.sh air-test [dir]       put a worktree under test in AIR (the pi-junie-dev agent entry)
#   scripts/dev.sh cli-test [dir] [-- pi args]  try a worktree in plain Pi, with its own Pi folder (not ~/.pi/agent)
#   scripts/dev.sh win-test [dir] [name]  from WSL, for AIR on Windows: copy a worktree's commit to %LOCALAPPDATA%\<name>
#
# What `setup` installs, and where:
#   in the repo, git-ignored   node_modules/ (npm ci)
#                              .agents/skills/om-*   upstream skills at the commit in skills-lock.json
#                              .agents/skills/agent-* links to your own review skills in ~/.claude/skills, if present
#                              .claude/skills/       links, so Claude Code sees the same skills as Pi
#                              .dev-tools/           Cezar and the skills installer, locked in scripts/dev-tools/
#                              .dev-tools/pi-junie/  the development agent: a copy of this repository at a fixed commit
#                              .dev-tools/pi-agent/  its Pi folder, with the plugins in scripts/dev-tools/pi-plugins.txt
#   outside the repo           nothing. Tools started later write their own state:
#                              ~/.cezar (Cezar), ~/.local/state/pi-junie (air-test link);
#                              win-test writes one folder on Windows: %LOCALAPPDATA%\pi-junie-dev (and .previous);
#                              cli-test keeps its Pi folder inside the worktree (.pi-dev/cli-agent, git-ignored)
# Network: npm registry and github.com/open-mercato/skills. Telemetry of both tools is switched off here.
#
# Settings: PI_JUNIE_ENV (key file, default ~/.config/pi-junie/env), PI_REVIEW_MODELS, PI_AUDIT_MODEL.
set -euo pipefail

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
  [[ -x "$MAIN/.dev-tools/node_modules/.bin/cezar" ]] && ok "Cezar $(jq -r .version "$MAIN/.dev-tools/node_modules/@open-mercato/cezar/package.json")" || miss "Cezar: scripts/dev.sh setup"
  if [[ -x "$MAIN/.dev-tools/pi-junie/node_modules/.bin/pi" ]]; then
    ok "development agent at $(git -C "$MAIN/.dev-tools/pi-junie" log -1 --format=%h 2>/dev/null) (scripts/dev.sh agent)"
  else miss "development agent: scripts/dev.sh setup"; fi
  if [[ -r "$ENV_FILE" ]] && grep -q '^JUNIE_API_KEY=.' "$ENV_FILE"; then ok "JetBrains AI key file $ENV_FILE"
  else note "no JUNIE_API_KEY in $ENV_FILE: headless Pi (audit, review, Cezar's Pi steps) needs it or a saved /login"; fi
  [[ -L "$STATE_DIR/under-test" ]] && note "under test in AIR: $(readlink "$STATE_DIR/under-test")"
  if [[ "$MISSING" -gt 0 ]]; then say "$MISSING missing. Run: scripts/dev.sh setup"; return 1; fi
  say "Ready."
}

cmd_setup() {
  [[ "$HERE" == "$MAIN" ]] || die "run setup in the main checkout ($MAIN); in a task worktree use: scripts/dev.sh worktree"
  node_ok || die "node >= 22.19 is required"
  for t in git jq npm curl; do command -v "$t" >/dev/null 2>&1 || die "$t is required"; done
  cd "$MAIN"

  say "1/5 dependencies"
  [[ -x node_modules/.bin/pi ]] || npm ci --no-audit --no-fund --loglevel=error >/dev/null

  # Cezar and the skills installer, with every dependency at the version in scripts/dev-tools/package-lock.json.
  say "2/5 developer tools into .dev-tools/ (locked in scripts/dev-tools/)"
  if ! cmp -s scripts/dev-tools/package-lock.json .dev-tools/package-lock.json || [[ ! -x .dev-tools/node_modules/.bin/skills ]]; then
    mkdir -p .dev-tools
    rm -f .dev-tools/package-lock.json
    cp scripts/dev-tools/package.json .dev-tools/package.json
    cp scripts/dev-tools/package-lock.json .dev-tools/package-lock.tmp
    mv .dev-tools/package-lock.tmp .dev-tools/package-lock.json
    (cd .dev-tools && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null) \
      || { rm -f .dev-tools/package-lock.json; die "installing the developer tools failed"; }
  fi

  say "3/5 upstream skills (commit pinned in skills-lock.json)"
  local need=0 s
  for s in $(jq -r '.skills | keys[]' skills-lock.json); do [[ -f ".agents/skills/$s/SKILL.md" ]] || need=1; done
  if [[ "$need" == 1 ]]; then
    # The installer downloads from GitHub and sometimes fails halfway; a second run finishes the rest.
    local log try
    log="$(mktemp)"
    for try in 1 2 3; do
      .dev-tools/node_modules/.bin/skills experimental_install --agent claude-code --agent pi --frozen-lockfile --yes >"$log" 2>&1 && break
      [[ "$try" == 3 ]] && { cat "$log" >&2; rm -f "$log"; die "installing the upstream skills failed"; }
      say "  retrying ($try)"
    done
    rm -f "$log"
  fi

  say "4/5 skill links"
  link_own_review_skills "$MAIN"
  link_claude_skills "$MAIN"

  say "5/5 development agent (.dev-tools/pi-junie, .dev-tools/pi-agent)"
  [[ -d "$DEV_AGENT/.git" ]] || agent_checkout "$(git rev-parse HEAD)"
  agent_plugins
  say
  cmd_check
}

# ---- the development agent: a copy of pi-junie at a fixed commit, with its own Pi folder (see scripts/pi-jbai)

DEV_AGENT="$MAIN/.dev-tools/pi-junie"
DEV_AGENT_DIR="$MAIN/.dev-tools/pi-agent"
PLUGIN_LIST="$MAIN/scripts/dev-tools/pi-plugins.txt"

agent_checkout() { # commit
  local commit="$1"
  if [[ ! -d "$DEV_AGENT/.git" ]]; then
    mkdir -p "$MAIN/.dev-tools"
    git clone -q --no-checkout "$MAIN" "$DEV_AGENT"
  else
    git -C "$DEV_AGENT" fetch -q origin
  fi
  git -C "$DEV_AGENT" checkout -q --detach "$commit"
  (cd "$DEV_AGENT" && npm ci --no-audit --no-fund --loglevel=error >/dev/null) || die "installing the development agent failed"
}

agent_plugin_version() { # package name -> installed version in the development agent, or nothing
  jq -r '.version // empty' "$DEV_AGENT_DIR/npm/node_modules/$1/package.json" 2>/dev/null || true
}

agent_plugins() {
  local line name want log
  [[ -f "$PLUGIN_LIST" ]] || return 0
  mkdir -p "$DEV_AGENT_DIR"
  while read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    name="${line#npm:}"; want="${name##*@}"; name="${name%@*}"
    [[ "$(agent_plugin_version "$name")" == "$want" ]] && continue
    say "  installing $name $want"
    log="$(mktemp)"
    PI_CODING_AGENT_DIR="$DEV_AGENT_DIR" "$DEV_AGENT/node_modules/.bin/pi" install "$line" </dev/null >"$log" 2>&1 \
      || { cat "$log" >&2; rm -f "$log"; die "installing $line failed"; }
    rm -f "$log"
  done <"$PLUGIN_LIST"
}

cmd_agent() {
  [[ "$HERE" == "$MAIN" ]] || die "run this in the main checkout ($MAIN)"
  case "${1:-status}" in
    status)
      [[ -d "$DEV_AGENT/.git" ]] || die "the development agent is not installed; run: scripts/dev.sh setup"
      say "Development agent (what scripts/pi-jbai runs):"
      say "  code     $DEV_AGENT"
      say "           at $(git -C "$DEV_AGENT" log -1 --format='%h %s' | cut -c1-90)"
      say "           main is $(git -C "$MAIN" rev-list --count "$(git -C "$DEV_AGENT" rev-parse HEAD)..main" 2>/dev/null || echo '?') commit(s) ahead of it"
      say "  Pi       $("$DEV_AGENT/node_modules/.bin/pi" --version 2>/dev/null)"
      say "  state    $DEV_AGENT_DIR"
      local line name
      while read -r line; do
        [[ -z "$line" || "$line" == \#* ]] && continue
        name="${line#npm:}"; name="${name%@*}"
        say "  plugin   $name $(agent_plugin_version "$name" | sed 's/^$/NOT INSTALLED/')"
      done <"$PLUGIN_LIST"
      say
      say "To use it in AIR as well (an entry in ~/.jetbrains/acp.json, next to \"pi-junie\"):"
      say "  \"pi-junie-stable\": { \"command\": \"$DEV_AGENT/bin/pi-air\", \"args\": [], \"env\": { \"PI_CODING_AGENT_DIR\": \"$DEV_AGENT_DIR\" } }"
      ;;
    update)
      local ref="${2:-main}" commit
      commit="$(git -C "$MAIN" rev-parse --verify -q "$ref^{commit}")" || die "no such commit: $ref"
      say "Moving the development agent to $(git -C "$MAIN" log -1 --format='%h %s' "$commit" | cut -c1-90)"
      agent_checkout "$commit"
      agent_plugins
      say "Done. Running sessions keep the old code until restarted."
      ;;
    *) die "usage: scripts/dev.sh agent [status | update [commit]]" ;;
  esac
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

# Plain Pi from a worktree: its own Pi, all its Pi packages (packages/* with pi.extensions, as pi-jbai loads them),
# the JetBrains AI key from $ENV_FILE, and a Pi folder inside the worktree, so ~/.pi/agent is never read or written.
cmd_cli_test() {
  local wt=. ext=() pkg
  if [[ $# -gt 0 && "$1" != -* ]]; then wt="$1"; shift; fi
  [[ "${1:-}" == "--" ]] && shift
  wt="$(cd "$wt" && git rev-parse --show-toplevel)"
  [[ -x "$wt/node_modules/.bin/pi" ]] || die "$wt has no dependencies; run: scripts/dev.sh worktree $wt"
  if [[ -r "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi
  export PI_CODING_AGENT_DIR="$wt/.pi-dev/cli-agent"
  mkdir -p "$PI_CODING_AGENT_DIR"
  for pkg in "$wt"/packages/*/; do
    [[ "$(jq -r '.pi.extensions // empty | length' "$pkg/package.json" 2>/dev/null)" -gt 0 ]] 2>/dev/null && ext+=(-e "${pkg%/}")
  done
  say "plain Pi from: $wt" >&2
  say "Pi folder:     $PI_CODING_AGENT_DIR (delete it to start clean; ~/.pi/agent is not used)" >&2
  exec "$wt/node_modules/.bin/pi" "${ext[@]}" "$@"
}

# AIR on Windows cannot run a WSL worktree: it needs Windows paths and Windows node modules. This copies the
# worktree's HEAD commit (git archive: no uncommitted change, no git-ignored file) to %LOCALAPPDATA%\<name>,
# installs its modules with Windows npm and prints the AIR entry. The folder it replaces is kept as <name>.previous.
cmd_win_test() {
  local wt name="${2:-pi-junie-dev}" local_w target target_w node_w head branch
  wt="$(cd "${1:-.}" && git rev-parse --show-toplevel)"
  command -v cmd.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1 || die "win-test runs in WSL (needs cmd.exe and wslpath)"
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || die "bad folder name: $name"
  local_w="$(cd /mnt/c && cmd.exe /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r')"
  [[ -n "$local_w" && "$local_w" != "%LOCALAPPDATA%" ]] || die "cannot read %LOCALAPPDATA% from Windows"
  target_w="$local_w\\$name"
  target="$(wslpath -u "$target_w")"
  node_w="$(cd /mnt/c && cmd.exe /c 'where node' 2>/dev/null | tr -d '\r' | head -1)"
  [[ -n "$node_w" ]] || die "Windows has no node on its PATH"
  head="$(git -C "$wt" rev-parse --short HEAD)"
  branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD)"
  [[ -z "$(git -C "$wt" status --porcelain --untracked-files=no)" ]] || say "note: $wt has uncommitted changes; they are NOT copied (only commit $head is)"
  if [[ -e "$target" ]]; then
    [[ -f "$target/WINDOWS-SOURCE.txt" ]] || die "$target_w exists and was not made by win-test (no WINDOWS-SOURCE.txt); move it away first"
    rm -rf "$target.previous"
    mv "$target" "$target.previous" || die "cannot move $target_w (files in use?); close the AIR chats that run it"
    say "kept the previous copy: $target_w.previous"
  fi
  mkdir -p "$target/.pi-dev"
  git -C "$wt" archive HEAD | tar -x -C "$target"
  printf 'Copy of pi-junie for AIR on Windows: branch %s, commit %s, made %s by scripts/dev.sh win-test. Not a git checkout.\n' \
    "$branch" "$head" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$target/WINDOWS-SOURCE.txt"
  say "copied $branch ($head) to $target_w; installing modules with Windows npm ..."
  (cd "$target" && cmd.exe /c 'npm ci --no-audit --no-fund --loglevel=error' 2>&1 | tr -d '\r' | sed 's/^/  /') || die "npm ci failed in $target_w"
  [[ -d "$target/node_modules" ]] || die "npm ci left no node_modules in $target_w"
  say
  say "AIR agent entry (once, in %USERPROFILE%\\.jetbrains\\acp.json):"
  say "  \"$name\": { \"command\": \"${node_w//\\/\\\\}\", \"args\": [\"${target_w//\\/\\\\}\\\\packages\\\\bridge\\\\src\\\\main.ts\"], \"env\": { \"PI_AIR_LOG\": \"${target_w//\\/\\\\}\\\\.pi-dev\\\\pi-air.log\" } }"
  say
  say "AIR keeps one bridge process per agent entry: a new chat does NOT load the new copy. Restart that process"
  say "(restart the IDE if nothing else does it), then check the log before testing:"
  say "  grep -v ':wire ' '$target/.pi-dev/pi-air.log' | grep -E 'starting pid=| plugin ' | tail"
  say "The last 'starting pid=' line must be later than now, $(date -u +%H:%M:%S) UTC."
}

case "${1:-help}" in
  setup)    shift; cmd_setup "$@" ;;
  check)    cmd_check ;;
  agent)    shift; cmd_agent "$@" ;;
  worktree) shift; cmd_worktree "$@" ;;
  cezar)    shift; cmd_cezar "$@" ;;
  audit)    shift; cmd_audit "$@" ;;
  review)   shift; cmd_review "$@" ;;
  air-test) shift; cmd_air_test "$@" ;;
  cli-test) shift; cmd_cli_test "$@" ;;
  win-test) shift; cmd_win_test "$@" ;;
  *)        sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
