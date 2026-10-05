# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b
- Copied from: `skills/install-anti-slop/assets/anti-slop/` (= upstream `src/` minus `*.test.ts`) via `scripts/install.mjs`
- Installed path: `tools/oxlint/anti-slop/` (generic plugin `index.ts`; Effect plugin `effect/` copied but not enabled — no direct `effect` dep)
- Config: `.oxlintrc.json`, all generic rules + `oxc/no-accumulating-spread` at `error`
- Deps: `oxlint` / `@oxlint/plugins` 1.87.0 (upstream tested against 1.78.0)
- Intentional deviations: none
