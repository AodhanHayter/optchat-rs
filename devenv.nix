{ pkgs, ... }:

{
  languages.rust.enable = true;
  languages.javascript = {
    enable = true;
    pnpm.enable = true;
  };
  languages.typescript.enable = true;

  packages = [ pkgs.git ];

  scripts = {
    lint.exec = ''cd "$DEVENV_ROOT" && pnpm run lint "$@"'';
    lint-fix.exec = ''cd "$DEVENV_ROOT" && pnpm run lint --fix "$@"'';
    typecheck.exec = ''cd "$DEVENV_ROOT" && pnpm run check "$@"'';
  };

  enterTest = ''
    set -e
    cargo fmt --check
    cargo clippy --locked --all-targets -- -D warnings
    cargo test --locked
    pnpm install --frozen-lockfile --ignore-scripts
    pnpm run lint
    pnpm run check
    pnpm test
  '';
}
