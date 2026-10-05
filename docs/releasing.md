# Publish a pi extension release

The release workflow is `.github/workflows/release.yml`.
It builds six Rust binaries, creates one npm tarball, and tests that tarball on each platform.
Only a pushed version tag can trigger npm publishing. Pull requests, branch pushes, and manual runs only build and test.
Nothing downloads or compiles during an end-user installation.

## Platforms and checks

| Package directory | Rust target | Standard GitHub runner |
| --- | --- | --- |
| `bin/linux-x64` | `x86_64-unknown-linux-gnu` | `ubuntu-22.04` |
| `bin/linux-arm64` | `aarch64-unknown-linux-gnu` | `ubuntu-22.04-arm` |
| `bin/darwin-x64` | `x86_64-apple-darwin` | `macos-15-intel` |
| `bin/darwin-arm64` | `aarch64-apple-darwin` | `macos-14` |
| `bin/win32-x64` | `x86_64-pc-windows-msvc` | `windows-2022` |
| `bin/win32-arm64` | `aarch64-pc-windows-msvc` | `windows-11-arm` |

Rust builds use 1.89.0, the minimum version declared in `Cargo.toml`.
Linux builds require glibc 2.35 or later. macOS builds set `MACOSX_DEPLOYMENT_TARGET=11.0`.
The test runners do not prove compatibility with every older operating-system release.
Windows storage limitations are described in [Import and backup](../README.md#import-and-backup).

The workflow runs formatting, Clippy, TypeScript checks, lint, and adapter tests.
Each platform also runs Rust release-mode tests, including writer-lock and crash-recovery tests.
The package smoke test installs without lifecycle scripts or peer dependencies.
It loads the installed extension through pi, starts its bundled binary, reads a saved message with `zoom`, and verifies shutdown releases the lock.
Tests use temporary directories and no paid model calls.

`npm pack` refuses packages with missing binaries, unequal Cargo/npm versions, or a mismatched release tag.
Only stable `vMAJOR.MINOR.PATCH` tags are supported. Prerelease tags fail validation rather than updating npm's `latest` tag.
All platforms must pass before the exact tested tarball can be published.

Standard runners are free for this public repository.
Intermediate binaries and the npm tarball have one-day artifact retention. The workflow does not create caches or use paid larger runners.
Download an artifact promptly if you need to keep it beyond the workflow run.

## Set up publishing once

You need permission to publish `pi-optchat` on npm and administer this GitHub repository.
The workflow uses npm trusted publishing through GitHub's short-lived identity tokens. It does not use an `NPM_TOKEN` secret.

1. Commit and push the workflow and package files to `master`.
2. In GitHub repository settings, create an environment named `npm` and add a required reviewer.
   Restrict deployment to release tags if you want GitHub to enforce that rule separately from the workflow.
3. Run the workflow without publishing:

   ```sh
   gh workflow run release.yml --ref master
   ```

4. Open the run in GitHub Actions. Confirm that every build and package smoke test passed.
   Note the successful run ID. Use that ID in place of `RUN_ID` below.

The npm package must exist before its trusted publisher can be configured.
For the first release only, download the tested tarball into a new directory and publish it with your npm account:

```sh
gh run download RUN_ID --name npm-package --dir release-artifact
npm login
npm publish release-artifact/pi-optchat-0.1.0.tgz --access public --ignore-scripts
```

Use the actual package version if it is no longer `0.1.0`.
This first local publish does not have GitHub provenance. Subsequent automated releases do.
Do not publish from the source checkout or bypass the checks to upload an incomplete package.

In the npm package settings, add this trusted publisher:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `AodhanHayter` |
| Repository | `optchat-rs` |
| Workflow filename | `release.yml` |
| Environment | `npm` |

Allow direct `npm publish` for this publisher.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for current setup requirements.
Do not push a tag for the already published bootstrap version: npm versions cannot be overwritten.

## Publish later versions

1. Update `package.json` and `Cargo.toml` to the same new version. Update `Cargo.lock` with Cargo.
2. Run `devenv test` and commit the version changes.
3. Push the commit and a matching tag. For example, after changing both manifests to `0.1.1`:

   ```sh
   git push origin master
   git tag v0.1.1
   git push origin v0.1.1
   ```

4. Wait for all build and smoke-test jobs to pass. Approve the `npm` environment deployment.
5. Confirm the published version:

   ```sh
   npm view pi-optchat@0.1.1 version
   ```

No npm credentials reach build or smoke-test jobs. Only the publish job can request an identity token.
The publish job uploads the tested artifact with provenance and does not rebuild it.
If publishing fails, inspect that job before retrying. If the version already exists on npm, do not try to overwrite it.
