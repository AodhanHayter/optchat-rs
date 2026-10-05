{ pkgs, ... }:

{
  languages.rust.enable = true;
  packages = [ pkgs.git pkgs.nodejs ];

  scripts = {
    lint.exec = ''cd "$DEVENV_ROOT" && npm run lint -- "$@"'';
    lint-fix.exec = ''cd "$DEVENV_ROOT" && npm run lint -- --fix "$@"'';
    typecheck.exec = ''cd "$DEVENV_ROOT" && npm run check'';
  };

  enterTest = ''
    set -e
    cargo fmt --check
    cargo clippy --all-targets -- -D warnings
    cargo test
    npm ci --ignore-scripts
    npm run check
    npm test
  '';
}
