import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const cargo = readFileSync(new URL("../Cargo.toml", import.meta.url), "utf8");

assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "Only stable release versions are supported");

assert.equal(pkg.version, cargo.match(/^version = "([^"]+)"/m)?.[1], "Cargo and npm versions must match");

if (process.env.GITHUB_REF_TYPE === "tag") {
  assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`, "Tag and package version must match");
}

for (const platform of ["linux", "darwin", "win32"]) {
  for (const arch of ["x64", "arm64"]) {
    const binary = new URL(`../bin/${platform}-${arch}/optchat${platform === "win32" ? ".exe" : ""}`, import.meta.url);
    const stat = statSync(binary);
    assert.ok(stat.isFile() && stat.size > 0, `Missing binary: ${binary}`);

    if (platform !== "win32") assert.ok(stat.mode & 0o111, `Binary is not executable: ${binary}`);
  }
}

console.log(`Package ${pkg.name}@${pkg.version}: all six binaries present`);
