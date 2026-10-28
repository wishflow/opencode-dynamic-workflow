#!/usr/bin/env bash
#
# ODW global install / rollback / status for opencode 2.1.0.
#
# Measured facts this script is built on (see PLAN §1 C8/C9 and §13):
#
#   * opencode auto-discovers exactly two things: `<project>/.opencode/plugins/<name>/`
#     and `~/.config/opencode/plugins/<name>/`. "Config `plugins: [...]` loads a
#     local directory" is FALSE on this build, and directory symlinks are not
#     followed - so a real directory with a real file is the only way in.
#   * A bare plugin *file* (`plugins/odw.mjs`) is not discovered; it produces
#     `level=WARN message="configured plugin path must be a directory"` on every
#     start. That WARN is the thing this migration removes.
#   * `OPENCODE_CONFIG_DIR` does NOT isolate the global config - the real
#     `~/.config/opencode/opencode.json` is always read. Hence: back up first,
#     and never run this from a test.
#
# Every mutation is recorded in a manifest so `rollback` is one command and
# deterministic. Nothing is deleted: old files are renamed to `*.disabled`.

set -euo pipefail

CONFIG_DIR="${ODW_GLOBAL_CONFIG_DIR:-$HOME/.config/opencode}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ENTRY="$REPO_DIR/src/index.ts"

PLUGIN_DIR_NAME="opencode-dynamic-workflow"
SHIM_DIR="$CONFIG_DIR/plugins/$PLUGIN_DIR_NAME"
SHIM_FILE="$SHIM_DIR/index.ts"
MANIFEST="$CONFIG_DIR/.odw-migration.json"
CONFIG_FILE="$CONFIG_DIR/opencode.json"

# Old global state left behind by project A. Renamed, never deleted.
LEGACY_FILES=(
  "plugins/odw.mjs"
  "commands/odw.md"
  "commands/ultracode.md"
  "commands/workflows.md"
)

die() { printf 'odw-global: %s\n' "$*" >&2; exit 1; }
info() { printf 'odw-global: %s\n' "$*"; }

# Strip the deprecated `plugin` key from opencode.json, returning what it held.
# Node is used rather than sed/python so the file is parsed, not pattern-matched.
strip_plugin_key() {
  ODW_CFG="$CONFIG_FILE" node --input-type=commonjs -e '
    const fs = require("node:fs")
    const path = process.env.ODW_CFG
    const doc = JSON.parse(fs.readFileSync(path, "utf8"))
    const had = Object.prototype.hasOwnProperty.call(doc, "plugin")
    const oldValue = had ? doc.plugin : null
    if (had) delete doc.plugin
    fs.writeFileSync(path, JSON.stringify(doc, null, 2) + "\n")
    process.stdout.write(JSON.stringify({ had, oldValue }))
  '
}

cmd_install() {
  [ -f "$REPO_ENTRY" ] || die "找不到插件入口 $REPO_ENTRY（脚本是在仓库里吗？）"
  [ -f "$CONFIG_FILE" ] || die "找不到 $CONFIG_FILE"
  if [ -f "$MANIFEST" ]; then
    die "已经迁移过了（$MANIFEST 存在）。先 'rollback'，或手工 rm 该清单后再 install。"
  fi

  local ts bak removed renamed_json
  ts="$(date +%Y%m%d-%H%M%S)"
  bak="$CONFIG_FILE.bak.$ts"

  # 1. Back up the config next to the other opencode.json.bak.* files in that dir.
  cp -p "$CONFIG_FILE" "$bak"
  info "已备份配置 → $bak"

  # 2. Install the shim as a real directory (a bare file is not discovered).
  mkdir -p "$SHIM_DIR"
  printf 'export { default } from "%s"\n' "$REPO_ENTRY" > "$SHIM_FILE"
  info "已安装 shim → $SHIM_FILE"

  # 3. Remove the deprecated `plugin` key (source of the startup WARN).
  removed="$(strip_plugin_key)"
  info "已处理 opencode.json 的 plugin 键：$removed"

  # 4. Rename the old plugin file and the old markdown commands to *.disabled.
  renamed_json="["
  local rel from to first=1
  for rel in "${LEGACY_FILES[@]}"; do
    from="$CONFIG_DIR/$rel"
    to="$from.disabled"
    if [ -f "$from" ]; then
      if [ -e "$to" ]; then
        info "跳过 $rel：$to 已存在"
      else
        mv "$from" "$to"
        info "已停用 $rel → $rel.disabled"
      fi
    fi
    if [ -e "$to" ] && [ ! -e "$from" ]; then
      [ "$first" -eq 1 ] || renamed_json+=","
      first=0
      renamed_json+="{\"from\":\"$rel\",\"to\":\"$rel.disabled\"}"
    fi
  done
  renamed_json+="]"

  # 5. Write the manifest so rollback knows exactly what this run changed.
  #
  # Install's order is the mirror of rollback's, and it is also deliberate:
  # the shim is installed *before* the config key goes away, so at no point does
  # `opencode.json` name a path that does not exist.
  cat > "$MANIFEST" <<JSON
{
  "version": 1,
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "repoDir": "$REPO_DIR",
  "repoEntry": "$REPO_ENTRY",
  "shim": "plugins/$PLUGIN_DIR_NAME/index.ts",
  "configBackup": "$(basename "$bak")",
  "pluginKey": $removed,
  "renamed": $renamed_json
}
JSON
  info "已写迁移清单 → $MANIFEST"

  cat <<EOF

迁移完成。下一步：
  1. 重启 opencode（全局配置在 server 启动时读取一次）。
  2. 启动日志里不再有 'configured plugin path must be a directory'。
  3. 用 /workflow <任务> 验证，或直接调 tools.odw.plan / tools.odw.run。
  4. 验证项目 A 的工具确实不可用（本来在 2.1.0 上也没生效）：odw_ultracode / odw_workflows 应不存在。
  5. 出问题：$0 rollback
EOF
}

cmd_rollback() {
  [ -f "$MANIFEST" ] || die "没有迁移清单 $MANIFEST，无从回滚"
  command -v node >/dev/null || die "需要 node 来读清单"

  local backup
  backup="$(ODW_MANIFEST="$MANIFEST" node --input-type=commonjs -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.env.ODW_MANIFEST,"utf8")).configBackup)')"

  # ORDER MATTERS, and it is the reverse of `install`:
  #   1. put the renamed files back   -> the paths the old config names exist again
  #   2. remove the shim
  #   3. restore opencode.json LAST   -> the `plugin` key never names a missing file
  #
  # Restoring the config first leaves a window where `plugin: ["./plugins/odw.mjs"]`
  # is live but the file is still `odw.mjs.disabled`. opencode's config watcher fires
  # inside that window and logs
  #   level=WARN message="failed to load plugin" cause="ENOENT .../odw.mjs"
  # - measured, and exactly the "plugin failed" toast this ordering removes.

  # 1. Put the renamed files back.
  ODW_CONFIG_DIR="$CONFIG_DIR" ODW_MANIFEST="$MANIFEST" node --input-type=commonjs -e '
    const fs = require("node:fs")
    const dir = process.env.ODW_CONFIG_DIR
    const m = JSON.parse(fs.readFileSync(process.env.ODW_MANIFEST, "utf8"))
    for (const { from, to } of m.renamed ?? []) {
      const a = `${dir}/${from}`, b = `${dir}/${to}`
      if (fs.existsSync(b) && !fs.existsSync(a)) {
        fs.renameSync(b, a)
        console.log(`已恢复 ${from}`)
      }
    }
  '

  # 2. Remove the shim directory (only if it is ours).
  if [ -f "$SHIM_FILE" ]; then
    rm -rf "$SHIM_DIR"
    info "已移除 shim → $SHIM_DIR"
  fi

  # 3. Restore opencode.json (this brings the old `plugin` key back).
  if [ -f "$CONFIG_DIR/$backup" ]; then
    cp -p "$CONFIG_DIR/$backup" "$CONFIG_FILE"
    info "已恢复配置 ← $backup"
  else
    info "警告：备份 $backup 不在，配置保持现状"
  fi

  rm -f "$MANIFEST"
  info "已删除迁移清单，回滚完成。重启 opencode 生效。"
}

cmd_status() {
  printf 'config dir      : %s\n' "$CONFIG_DIR"
  printf 'repo dir        : %s\n' "$REPO_DIR"
  if [ -f "$MANIFEST" ]; then
    printf 'migration       : 已迁移\n'
    sed 's/^/                  /' "$MANIFEST"
  else
    printf 'migration       : 未迁移（无 %s）\n' "$(basename "$MANIFEST")"
  fi
  if [ -f "$SHIM_FILE" ]; then
    printf 'shim            : %s\n' "$(cat "$SHIM_FILE")"
  else
    printf 'shim            : 不存在\n'
  fi
  if grep -q '"plugin"' "$CONFIG_FILE" 2>/dev/null; then
    printf 'plugin key      : 仍存在（启动会有 must-be-a-directory WARN）\n'
  else
    printf 'plugin key      : 已清除\n'
  fi
  local rel
  for rel in "${LEGACY_FILES[@]}"; do
    if [ -e "$CONFIG_DIR/$rel" ]; then
      printf 'legacy          : %s 仍然启用\n' "$rel"
    elif [ -e "$CONFIG_DIR/$rel.disabled" ]; then
      printf 'legacy          : %s 已停用\n' "$rel"
    fi
  done
}

case "${1:-}" in
  install) cmd_install ;;
  rollback) cmd_rollback ;;
  status) cmd_status ;;
  *) cat <<EOF
用法: $0 {install|rollback|status}

  install   备份全局配置 → 安装 shim → 清除已废弃的 plugin 键 → 停用 project A 的插件与命令
  rollback  按迁移清单恢复：还原 opencode.json、把 *.disabled 改回来、移除 shim
  status    打印当前状态

环境变量:
  ODW_GLOBAL_CONFIG_DIR  覆盖全局配置目录（默认 \$HOME/.config/opencode）
EOF
    exit 1 ;;
esac
