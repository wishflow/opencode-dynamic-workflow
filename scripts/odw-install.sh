#!/usr/bin/env bash
#
# ODW install / update / status / rollback for opencode v2.
#
#   ./scripts/odw-install.sh --global          # install (default scope)
#   ./scripts/odw-install.sh install --local   # install into the current project
#   ./scripts/odw-install.sh update            # refresh plugin + skill
#   ./scripts/odw-install.sh status
#   ./scripts/odw-install.sh rollback
#
# One-liner (no checkout needed):
#
#   curl -fsSL https://raw.githubusercontent.com/wishflow/opencode-dynamic-workflow/main/scripts/odw-install.sh | sh -s -- --global
#
# Two things are installed, and they are independent:
#
#   1. the plugin package, through opencode's own installer -
#      `opencode plugin add github:wishflow/opencode-dynamic-workflow`. The CLI records the
#      spec in the configuration and installs the package eagerly.
#   2. the `odw` skill, as a real file at `<root>/skills/odw/SKILL.md`. The plugin updates
#      itself, but the skill is a snapshot, which is why `update` refreshes both.
#
# Measured facts this script is built on:
#
#   * `opencode plugin add | remove | update` only ever touch the GLOBAL configuration; there
#     is no `--local` flag. `--local` therefore writes the project `opencode.json` itself.
#   * `plugin add` installs eagerly. Adding the spec by hand instead makes the host npm-install
#     ~273 packages during its next start (measured: ~2.5 minutes, during which the plugin is
#     simply absent).
#   * A git spec with no ref follows the branch (`main`), which is what `plugin update` tracks.
#   * Skill discovery is `<root>/skills/<name>/SKILL.md`; the name comes from the frontmatter.
#   * `HOME=<dir>` isolates the global configuration; `XDG_CONFIG_HOME` does not.
#
# The one piece of custom machinery left is project A's leftovers (a bare `plugins/odw.mjs`
# plus three markdown commands). Files are renamed, never deleted, and every mutation is
# recorded in a manifest so `rollback` stays one deterministic command.
#
# ORDER INVARIANT: file changes come before configuration changes, and `rollback` restores the
# configuration LAST. Restoring it first opens a window where the configuration names a file
# that does not exist yet; opencode's plugin reconcile fires inside that window and logs
# `failed to load plugin ... ENOENT` (measured, M5).
#
# The one-liner pipes this script into `sh`, so it stays POSIX-friendly: no arrays, and
# `pipefail` is enabled only when the shell supports it (dash does not).

set -eu
(set -o pipefail) 2>/dev/null && set -o pipefail

PLUGIN_SPEC="github:wishflow/opencode-dynamic-workflow"
RAW_BASE="https://raw.githubusercontent.com/wishflow/opencode-dynamic-workflow"
SKILL_REL="skills/odw/SKILL.md"
SKILL_NAME="odw"

# Project A's global leftovers. Renamed to *.disabled, never deleted.
LEGACY_FILES="plugins/odw.mjs commands/odw.md commands/ultracode.md commands/workflows.md"

die() { printf 'odw-install: %s\n' "$*" >&2; exit 1; }
info() { printf 'odw-install: %s\n' "$*"; }
warn() { printf 'odw-install: WARN %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
usage: odw-install.sh [install|update|status|rollback] [--global|--local] [--ref <git-ref>]

  install    (default) install the plugin and the odw skill
  update     update the plugin package and re-fetch the skill
  status     report what is installed and whether the skill is current
  rollback   undo an install: restore project A leftovers and the config backup

  --global   install for every project (default). Writes to $HOME/.config/opencode.
  --local    install for the current project only. Writes to $PWD/opencode.json
             and $PWD/.opencode/skills/odw/.
  --ref <r>  git ref to fetch the skill from (default: main)

environment:
  ODW_GLOBAL_CONFIG_DIR  override the global config dir (default: $HOME/.config/opencode)
  ODW_REPO_DIR           use the skill from this checkout instead of downloading it
  ODW_NODE               node-compatible binary used for JSON edits (default: node)
EOF
}

# ---------------------------------------------------------------- argument parsing

MODE=""
SCOPE="global"
REF="main"

while [ $# -gt 0 ]; do
  case "$1" in
    install|update|status|rollback) MODE="$1" ;;
    --global) SCOPE="global" ;;
    --local) SCOPE="local" ;;
    --ref) shift; [ $# -gt 0 ] || die "--ref needs a value"; REF="$1" ;;
    --ref=*) REF="${1#--ref=}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done
MODE="${MODE:-install}"

# ---------------------------------------------------------------- locations

GLOBAL_CONFIG_DIR="${ODW_GLOBAL_CONFIG_DIR:-$HOME/.config/opencode}"
PROJECT_DIR="$(pwd)"

if [ "$SCOPE" = "global" ]; then
  CONFIG_DIR="$GLOBAL_CONFIG_DIR"
  CONFIG_FILE="$CONFIG_DIR/opencode.json"
  MANIFEST="$CONFIG_DIR/.odw-migration.json"
  SKILL_FILE="$CONFIG_DIR/skills/$SKILL_NAME/SKILL.md"
  SCOPE_LABEL="global"
else
  # A project keeps both halves under the project root: opencode.json next to the code, and
  # the skill inside the same .opencode directory the rest of a project's opencode state uses.
  CONFIG_DIR="$PROJECT_DIR/.opencode"
  CONFIG_FILE="$PROJECT_DIR/opencode.json"
  MANIFEST="$CONFIG_DIR/.odw-migration.json"
  SKILL_FILE="$CONFIG_DIR/skills/$SKILL_NAME/SKILL.md"
  SCOPE_LABEL="local ($PROJECT_DIR)"
fi

# The skill comes from the checkout when this script runs from one (works offline and matches
# the ref you are on); otherwise it is downloaded, which is what `curl | sh` does.
REPO_DIR=""
detect_repo() {
  for candidate in "${ODW_REPO_DIR:-}" "$(dirname "$0")/.."; do
    [ -n "$candidate" ] || continue
    [ -f "$candidate/$SKILL_REL" ] || continue
    REPO_DIR="$(cd "$candidate" && pwd)" && return 0
  done
  return 1
}
detect_repo || true

NODE="${ODW_NODE:-node}"
command -v "$NODE" >/dev/null 2>&1 || die "node is required to read and write JSON (set ODW_NODE to use a different executable)"
# Being on PATH is not the same as being runnable: a broken Homebrew node (missing dylib)
# exists but aborts on every call, which would kill the script after it had already started
# mutating state. Fail before the first mutation instead.
"$NODE" -e 'process.exit(0)' >/dev/null 2>&1 || die "$NODE exists but cannot be executed (set ODW_NODE to use a different executable)"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}

require_manifest() {
  if [ ! -f "$MANIFEST" ]; then
    die "no install manifest at $MANIFEST - run install first"
  fi
}

require_opencode() {
  command -v opencode >/dev/null 2>&1 || die "opencode is not on PATH"
}

# ---------------------------------------------------------------- skill

write_skill() {
  mkdir -p "$(dirname "$SKILL_FILE")"
  if [ -n "$REPO_DIR" ] && [ -f "$REPO_DIR/$SKILL_REL" ]; then
    cp -p "$REPO_DIR/$SKILL_REL" "$SKILL_FILE"
    info "skill written (from the local checkout $REPO_DIR) -> $SKILL_FILE"
  else
    command -v curl >/dev/null 2>&1 || die "curl is required to download $SKILL_REL (or set ODW_REPO_DIR)"
    curl -fsSL "$RAW_BASE/$REF/$SKILL_REL" -o "$SKILL_FILE" || die "failed to download $SKILL_REL (ref=$REF)"
    info "skill written (from $RAW_BASE/$REF) -> $SKILL_FILE"
  fi
}

remove_skill() {
  if [ ! -f "$SKILL_FILE" ]; then return 0; fi
  rm -f "$SKILL_FILE"
  # Clean up the directories this script created, but only while they are empty.
  rmdir "$(dirname "$SKILL_FILE")" 2>/dev/null || true
  rmdir "$(dirname "$(dirname "$SKILL_FILE")")" 2>/dev/null || true
  info "skill removed -> $SKILL_FILE"
}

# ---------------------------------------------------------------- JSON helpers (node)

# Adds the plugin spec to a project config, creating the file if needed. Emits
# "added" or "present".
#
# These snippets deliberately avoid a top-level `return`: on Node 25 `node -e` rejects it
# with "Return statement is not allowed here", even under `--input-type=commonjs`.
json_add_plugin() {
  ODW_CFG="$CONFIG_FILE" ODW_SPEC="$PLUGIN_SPEC" "$NODE" -e '
    const fs = require("node:fs")
    const file = process.env.ODW_CFG
    let doc = { $schema: "https://opencode.ai/config.json" }
    if (fs.existsSync(file)) doc = JSON.parse(fs.readFileSync(file, "utf8"))
    const list = Array.isArray(doc.plugins) ? doc.plugins : []
    if (list.includes(process.env.ODW_SPEC)) {
      console.log("present")
    } else {
      doc.plugins = [...list, process.env.ODW_SPEC]
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n")
      console.log("added")
    }
  '
}

# Removes the plugin spec from a project config. Emits "removed" or "absent".
json_remove_plugin() {
  ODW_CFG="$CONFIG_FILE" ODW_SPEC="$PLUGIN_SPEC" "$NODE" -e '
    const fs = require("node:fs")
    const file = process.env.ODW_CFG
    const spec = process.env.ODW_SPEC
    if (!fs.existsSync(file)) {
      console.log("absent")
    } else {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"))
      const list = Array.isArray(doc.plugins) ? doc.plugins : []
      if (!list.includes(spec)) {
        console.log("absent")
      } else {
        doc.plugins = list.filter((p) => p !== spec)
        if (doc.plugins.length === 0) delete doc.plugins
        fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n")
        console.log("removed")
      }
    }
  '
}

# Reads the deprecated `plugin` key WITHOUT touching it, so the planning phase can record a
# complete manifest before the first mutation.
json_read_plugin_key() {
  ODW_CFG="$CONFIG_FILE" "$NODE" -e '
    const fs = require("node:fs")
    const doc = JSON.parse(fs.readFileSync(process.env.ODW_CFG, "utf8"))
    const had = Object.prototype.hasOwnProperty.call(doc, "plugin")
    process.stdout.write(JSON.stringify({ had, oldValue: had ? doc.plugin : null }))
  '
}

# Strips the deprecated `plugin` key from the global config, returning what it held. That key
# names a bare plugin *file*, which opencode 2.1.0 no longer discovers: it only produces a
# startup WARN.
json_strip_plugin_key() {
  ODW_CFG="$CONFIG_FILE" "$NODE" -e '
    const fs = require("node:fs")
    const doc = JSON.parse(fs.readFileSync(process.env.ODW_CFG, "utf8"))
    const had = Object.prototype.hasOwnProperty.call(doc, "plugin")
    const oldValue = had ? doc.plugin : null
    if (had) delete doc.plugin
    fs.writeFileSync(process.env.ODW_CFG, JSON.stringify(doc, null, 2) + "\n")
    process.stdout.write(JSON.stringify({ had, oldValue }))
  '
}

# Planning halves of the legacy migration. They are separate from the executing halves because
# the manifest has to be complete before anything is renamed: otherwise a failure halfway
# leaves a configured-but-unrecorded mutation that `rollback` cannot see.
plan_renames() {
  local rel from to json="[" first=1
  for rel in $LEGACY_FILES; do
    from="$CONFIG_DIR/$rel"
    to="$from.disabled"
    # Record only what this install actually renames. A file that was already disabled before
    # the install must NOT be recorded: `rollback` restores every entry, so recording it would
    # turn a pre-existing `*.disabled` back into an active file - a regression against the
    # state the install found.
    if [ -f "$from" ] && [ ! -e "$to" ]; then
      if [ "$first" -eq 1 ]; then first=0; else json="$json,"; fi
      json="$json{\"from\":\"$rel\",\"to\":\"$rel.disabled\"}"
    fi
  done
  printf '%s]' "$json"
}

apply_renames() {
  local rel from to
  for rel in $LEGACY_FILES; do
    from="$CONFIG_DIR/$rel"
    to="$from.disabled"
    if [ -f "$from" ] && [ ! -e "$to" ]; then
      mv "$from" "$to"
      info "disabled $rel -> $rel.disabled"
    elif [ -e "$to" ] && [ ! -e "$from" ]; then
      info "skipping $rel: $to already exists"
    fi
  done
}

# `write_manifest ""` records everything known before the install runs; the final call passes
# the skill's sha256. Both read the caller's `config_backup`, `config_created`, `plugin_key`,
# `renamed_json` and `skill_existed` (shell locals are dynamically scoped), and every read
# carries a default because dash's `local` leaves a variable unset rather than empty, which
# `set -u` then rejects.
write_manifest() {
  local sha="${1:-}"
  local backup="${config_backup:-}"
  local created="${config_created:-0}"
  local pkey="${plugin_key:-null}"
  local ren="${renamed_json:-[]}"
  local existed="${skill_existed:-false}"
  # A project install keeps its manifest inside `.opencode/`, which may not exist yet.
  mkdir -p "$CONFIG_DIR"
  cat > "$MANIFEST" <<JSON
{
  "version": 2,
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "scope": "$SCOPE",
  "ref": "$REF",
  "pluginSpec": "$PLUGIN_SPEC",
  "configBackup": "$([ -n "$backup" ] && printf '%s' "$backup" || printf 'null')",
  "configCreated": $([ "$created" -eq 1 ] && printf 'true' || printf 'false'),
  "pluginKey": $pkey,
  "renamed": $ren,
  "skill": { "path": "$SKILL_FILE", "sha256": "$sha", "existedBefore": $existed }
}
JSON
}

json_has_plugin_spec() {
  if [ ! -f "$CONFIG_FILE" ]; then printf 'no'; return 0; fi
  ODW_CFG="$CONFIG_FILE" ODW_SPEC="$PLUGIN_SPEC" "$NODE" -e '
    const fs = require("node:fs")
    const doc = JSON.parse(fs.readFileSync(process.env.ODW_CFG, "utf8"))
    const list = Array.isArray(doc.plugins) ? doc.plugins : []
    process.stdout.write(list.includes(process.env.ODW_SPEC) ? "yes" : "no")
  '
}

# Reads a dotted path out of the manifest, e.g. `skill.sha256`.
manifest_field() {
  ODW_MANIFEST="$MANIFEST" ODW_FIELD="$1" "$NODE" -e '
    const fs = require("node:fs")
    const doc = JSON.parse(fs.readFileSync(process.env.ODW_MANIFEST, "utf8"))
    const value = process.env.ODW_FIELD.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), doc)
    process.stdout.write(value == null ? "" : String(value))
  '
}

# ---------------------------------------------------------------- install

cmd_install() {
  if [ -f "$MANIFEST" ]; then
    die "already installed ($MANIFEST). Run rollback first, or delete the manifest and reinstall."
  fi

  local ts bak config_backup="" config_created=0 plugin_key="null" renamed_json="[]" sha add_result skill_existed="false"

  # --- 1. plan, and record the plan BEFORE the first mutation ---
  #
  # The manifest is written first on purpose. Measured: `opencode plugin add` can fail on a
  # transient registry error after the configuration has already been touched, and without a
  # manifest `rollback` has nothing to work from.
  if [ -f "$CONFIG_FILE" ]; then
    ts="$(date +%Y%m%d-%H%M%S)"
    # The backup sits next to the configuration file, which for a project install is NOT the
    # `.opencode` directory that holds the manifest. The absolute path is recorded so
    # `rollback` never has to guess which directory it meant.
    bak="$CONFIG_FILE.bak.$ts"
    cp -p "$CONFIG_FILE" "$bak"
    config_backup="$bak"
    info "config backed up -> $bak"
  else
    config_created=1
    info "no config yet; it will be created: $CONFIG_FILE"
  fi

  if [ -f "$SKILL_FILE" ]; then skill_existed="true"; fi

  renamed_json="$(plan_renames)"
  plugin_key="null"
  if [ "$SCOPE" = "global" ] && [ -f "$CONFIG_FILE" ]; then
    plugin_key="$(json_read_plugin_key)"
  fi

  write_manifest ""
  info "manifest written first, before any change, so a failure can still roll back -> $MANIFEST"

  # --- 2. project A leftovers (files, then the config key) ---
  apply_renames
  if [ "$plugin_key" != "null" ]; then
    json_strip_plugin_key >/dev/null
    info "handled the plugin key of opencode.json: $plugin_key"
  fi

  # --- 3. the plugin, through opencode's own installer ---
  if [ "$SCOPE" = "global" ]; then
    require_opencode
    mkdir -p "$CONFIG_DIR"
    info "installing the plugin (opencode fetches the dependencies now, which can take a minute or two)..."
    if ! opencode plugin add "$PLUGIN_SPEC"; then
      # Measured once: the registry answered a dependency resolution with
      # "No matching version found for @redis/json@6.3.1" although that version exists.
      warn "opencode plugin add failed; retrying once in 10s..."
      sleep 10
      opencode plugin add "$PLUGIN_SPEC" ||
        die "opencode plugin add failed (already retried once). Fix it and rerun: $0 install --$SCOPE; or roll back first: $0 rollback --$SCOPE"
    fi
  else
    add_result="$(json_add_plugin)"
    if [ "$add_result" = "added" ]; then
      info "wrote the plugins key of the project config -> $CONFIG_FILE"
      warn "a project install does not fetch dependencies up front: opencode installs the package in the background on its next start (about 2.5 minutes the first time, and the plugin is unavailable until then)"
    else
      info "the project config already lists this plugin; not writing it again"
    fi
  fi

  # --- 4. the skill LAST, so the trigger surface appears only once the executor is there ---
  write_skill
  sha="$(sha256_of "$SKILL_FILE")"
  write_manifest "$sha"

  cat <<EOF

Install complete ($SCOPE_LABEL).
  1. Restart opencode: the config and the plugins are read when the server starts.
  2. Verify the plugin: opencode plugin list should show a line: odw  <commit>  $PLUGIN_SPEC
  3. Verify the trigger: ask for a job that repeats one thing N times; it should load the odw skill and call odw_plan / odw_run.
  4. If something breaks: $0 rollback --$SCOPE
EOF
}

# ---------------------------------------------------------------- update

cmd_update() {
  require_manifest

  if [ "$SCOPE" = "global" ]; then
    require_opencode
    info "updating the plugin package..."
    opencode plugin update "$PLUGIN_SPEC" ||
      warn "opencode plugin update returned non-zero (package not updated: it needs a reachable opencode service); the skill will still be refreshed"
  else
    info "a project install follows the $REF branch and opencode resolves it at start; only the skill is refreshed here"
  fi

  write_skill
  local sha
  sha="$(sha256_of "$SKILL_FILE")"
  ODW_MANIFEST="$MANIFEST" ODW_SHA="$sha" "$NODE" -e '
    const fs = require("node:fs")
    const file = process.env.ODW_MANIFEST
    const doc = JSON.parse(fs.readFileSync(file, "utf8"))
    doc.installedAt = new Date().toISOString()
    doc.skill = { ...(doc.skill ?? {}), sha256: process.env.ODW_SHA }
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n")
  '
  info "refreshed the skill digest in the manifest"
}

# ---------------------------------------------------------------- status

cmd_status() {
  printf 'scope           : %s\n' "$SCOPE_LABEL"
  printf 'config file     : %s\n' "$CONFIG_FILE"
  printf 'skill file      : %s\n' "$SKILL_FILE"

  # A local install is easy to forget about, since the default scope is global.
  if [ "$SCOPE" = "global" ] && [ -f "$PROJECT_DIR/.opencode/.odw-migration.json" ]; then
    printf 'note            : this project has a local install (add --local to see it)\n'
  fi

  if [ -f "$MANIFEST" ]; then
    printf 'manifest        : %s\n' "$MANIFEST"
  else
    printf 'manifest        : absent (never installed, or the manifest was deleted)\n'
  fi

  local state
  state="$(json_has_plugin_spec)"
  if [ "$state" = "yes" ]; then
    printf 'plugin spec     : registered (config contains %s)\n' "$PLUGIN_SPEC"
  else
    printf 'plugin spec     : not registered\n'
  fi

  if [ -f "$SKILL_FILE" ]; then
    local sha recorded
    sha="$(sha256_of "$SKILL_FILE")"
    recorded=""
    if [ -f "$MANIFEST" ]; then recorded="$(manifest_field skill.sha256)"; fi
    printf 'skill sha256    : %s\n' "$sha"
    if [ -n "$recorded" ]; then
      if [ "$recorded" = "$sha" ]; then
        printf 'skill freshness : matches the digest recorded at install time\n'
      else
        printf 'skill freshness : differs from the recorded digest (updated, or edited by hand)\n'
      fi
    fi
    if [ -n "$REPO_DIR" ] && [ -f "$REPO_DIR/$SKILL_REL" ]; then
      if [ "$(sha256_of "$REPO_DIR/$SKILL_REL")" = "$sha" ]; then
        printf 'skill vs repo   : matches the local checkout (%s)\n' "$REPO_DIR"
      else
        printf 'skill vs repo   : differs from the local checkout - run update to sync\n'
      fi
    fi
  else
    printf 'skill           : absent\n'
  fi

  local rel
  for rel in $LEGACY_FILES; do
    if [ -e "$CONFIG_DIR/$rel" ]; then
      printf 'legacy          : %s is still enabled\n' "$rel"
    elif [ -e "$CONFIG_DIR/$rel.disabled" ]; then
      printf 'legacy          : %s is disabled\n' "$rel"
    fi
  done
}

# ---------------------------------------------------------------- rollback

cmd_rollback() {
  require_manifest

  local backup backup_file config_created scope
  backup="$(manifest_field configBackup)"
  config_created="$(manifest_field configCreated)"
  scope="$(manifest_field scope)"

  # Version 2 manifests store an absolute path. A bare name is honoured as a fallback and
  # resolved next to the configuration file.
  backup_file=""
  if [ -n "$backup" ]; then
    case "$backup" in
      /*) backup_file="$backup" ;;
      *) backup_file="$(dirname "$CONFIG_FILE")/$backup" ;;
    esac
  fi

  # 1. put project A's files back, so the paths the old config names exist again.
  ODW_CONFIG_DIR="$CONFIG_DIR" ODW_MANIFEST="$MANIFEST" "$NODE" -e '
    const fs = require("node:fs")
    const dir = process.env.ODW_CONFIG_DIR
    const m = JSON.parse(fs.readFileSync(process.env.ODW_MANIFEST, "utf8"))
    for (const { from, to } of m.renamed ?? []) {
      const a = `${dir}/${from}`, b = `${dir}/${to}`
      if (fs.existsSync(b) && !fs.existsSync(a)) {
        fs.renameSync(b, a)
        console.log(`restored ${from}`)
      }
    }
  '

  # 2. take the skill away. There is no shadow copy of it: a skill that existed before the
  #    install and was overwritten is gone, which is what the manifest's `existedBefore`
  #    records so `status` can warn before it happens.
  remove_skill

  # 3. configuration LAST. A backup is authoritative; without one nothing beyond the spec this
  #    script added is touched, so settings changed after installing survive the rollback.
  if [ -n "$backup_file" ] && [ -f "$backup_file" ]; then
    cp -p "$backup_file" "$CONFIG_FILE"
    info "config restored from $backup_file"
  elif [ "$scope" != "global" ] && [ "$config_created" = "true" ]; then
    rm -f "$CONFIG_FILE"
    info "removed the config that the install created -> $CONFIG_FILE"
  elif [ "$scope" = "global" ]; then
    if command -v opencode >/dev/null 2>&1; then opencode plugin remove "$PLUGIN_SPEC" || true; fi
    info "removed $PLUGIN_SPEC from the global config"
  else
    local removed
    removed="$(json_remove_plugin)"
    info "removed the plugin from the project config: $removed"
  fi

  rm -f "$MANIFEST"
  # Leave nothing behind for a project install: remove the dirs this script created, but only
  # while they are empty (a project may keep its own state in `.opencode/`).
  rmdir "$CONFIG_DIR" 2>/dev/null || true
  info "manifest deleted; rollback complete. Restart opencode for it to take effect."
}

case "$MODE" in
  install) cmd_install ;;
  update) cmd_update ;;
  status) cmd_status ;;
  rollback) cmd_rollback ;;
esac
