// Local-development entry point for opencode.
//
// Measured on opencode 2.1.0 (see PLAN §12.1):
//   - `.opencode/plugins/<name>/` is auto-discovered; the config `plugins: [...]`
//     array does NOT load a local directory in this build.
//   - directory symlinks are not followed.
//   - TypeScript is loaded as-is (Bun runtime), so `src/` is the single source of
//     truth and there is no build step.
//
// The same one-line shim is what the global install uses, pointed at this repo.
export { default } from "../../../src/index.ts"
