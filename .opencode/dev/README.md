# Dev entry point (NOT auto-discovered)

`plugin-entry.ts` is the one-line re-export of the repo's plugin, used for manual
and end-to-end loading.

It deliberately does **not** live in `.opencode/plugins/`, because opencode
auto-discovers every `<cwd>/.opencode/plugins/<name>/index.ts` and watches it.
While the file sat there, every edit under `src/` reloaded the plugin in the
editor session and refreshed the whole tool/skill catalog mid-edit.

## Load it somewhere

Loading only works from `<project>/.opencode/plugins/<name>/index.ts` (PLAN §12.1;
directory symlinks are not followed, and the config `plugins: [...]` array does
not load a local directory). So a test project gets its own tiny shim:

```sh
DIR=$(mktemp -d)
mkdir -p "$DIR/.opencode/plugins/odw"
printf 'export { default } from "%s/src/index.ts"\n' \
  "$(cd "$(dirname "$0")/../.." && pwd)" > "$DIR/.opencode/plugins/odw/index.ts"
```

For interactive use, copy `plugin-entry.ts` to
`~/.config/opencode/plugins/odw/index.ts` and restart opencode.

The global install (M5) uses the same one-line shim, pointed at a stable copy of
the repo.
