import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertPackageLockConsistent,
  classifyOwnedPath,
  collectDeliveryManifest,
  collectDesktopManifest,
  main,
  renderDeliveryReport,
} from "../scripts/qa-delivery-manifest.mjs";

async function rmRetry(path, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try { return await rm(path, { recursive: true, force: true }); }
    catch (err) {
      if (err.code !== "EBUSY" || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

async function createGitFixture() {
  const root = await mkdtemp(join(tmpdir(), "514cc-delivery-manifest-"));
  const files = [
    "apps/control-center/src/kept.mjs",
    "apps/control-center/tests/kept.test.mjs",
    "apps/control-center/public/kept.css",
  ];
  for (const file of files) {
    const path = resolve(root, file);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, "export default true;\n", "utf8");
  }
  execFileSync("git", ["init", "-q", root], { windowsHide: true });
  execFileSync("git", ["-C", root, "config", "user.email", "qa@example.test"], { windowsHide: true });
  execFileSync("git", ["-C", root, "config", "user.name", "QA"], { windowsHide: true });
  execFileSync("git", ["-C", root, "add", "."], { windowsHide: true });
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"], { windowsHide: true });
  return root;
}

test("delivery manifest reports untracked source/tests and deleted tracked files", async (t) => {
  const root = await createGitFixture();
  t.after(() => rmRetry(root));
  await writeFile(resolve(root, "apps/control-center/src/new.mjs"), "export default false;\n", "utf8");
  await writeFile(resolve(root, "apps/control-center/tests/new.test.mjs"), "// untracked test\n", "utf8");
  await writeFile(resolve(root, "apps/control-center/public/preview.png"), "not a code file\n", "utf8");
  await rm(resolve(root, "apps/control-center/public/kept.css"));

  const manifest = await collectDeliveryManifest({
    repoRoot: root,
    focusPaths: ["apps/control-center/src", "apps/control-center/public", "apps/control-center/tests"],
  });
  assert.deepEqual(manifest.untrackedSourceOrTests, [
    "apps/control-center/src/new.mjs",
    "apps/control-center/tests/new.test.mjs",
  ]);
  assert.deepEqual(manifest.untrackedFiles, [
    "apps/control-center/public/preview.png",
    "apps/control-center/src/new.mjs",
    "apps/control-center/tests/new.test.mjs",
  ]);
  assert.deepEqual(manifest.deletedTrackedFiles, ["apps/control-center/public/kept.css"]);
  assert.equal(manifest.clean, false);
  assert.equal(manifest.strictFailure, true);
  const report = renderDeliveryReport(manifest);
  assert.match(report, /status: drift; strict: fail/);
  assert.match(report, /apps\/control-center\/src\/new\.mjs/);
});

test("desktop manifest closes the Tauri source tree and excludes target/ build artifacts", async (t) => {
  const root = await createGitFixture();
  t.after(() => rmRetry(root));
  const desktop = [
    "apps/desktop/ui/index.html",
    "apps/desktop/src-tauri/Cargo.toml",
    "apps/desktop/src-tauri/src/main.rs",
    "apps/desktop/src-tauri/capabilities/native.json",
    "apps/desktop/src-tauri/tauri.conf.json",
  ];
  for (const file of desktop) {
    const path = resolve(root, file);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, "x\n", "utf8");
  }
  // 巨型构建目录必须在桌面闭包之外（P0-11）
  await mkdir(resolve(root, "apps/desktop/src-tauri/target/release"), { recursive: true });
  await writeFile(resolve(root, "apps/desktop/src-tauri/target/release/cc-desktop.exe"), "MZ", "utf8");
  execFileSync("git", ["-C", root, "add", "."], { windowsHide: true });
  execFileSync("git", ["-C", root, "commit", "-qm", "desktop fixture"], { windowsHide: true });

  const manifest = await collectDesktopManifest({ repoRoot: root });
  assert.equal(manifest.clean, true, "all desktop source tracked; build artifact excluded from closure");
  assert.equal(manifest.strictFailure, false);
  assert.ok(manifest.trackedFiles.includes("apps/desktop/src-tauri/src/main.rs"), "desktop Rust source is closed");
  assert.ok(manifest.trackedFiles.includes("apps/desktop/ui/index.html"), "embedded startup page is a build input");
  assert.ok(!manifest.trackedFiles.includes("apps/desktop/src-tauri/target/release/cc-desktop.exe"), "target/ is never part of the delivery closure");
  assert.ok(!manifest.physicalFiles.some((path) => path.includes("/target/")), "physical walk excludes target/");
  assert.ok(!manifest.untrackedFiles.some((path) => path.includes("/target/")), "git-untracked walk excludes target/");

  const iconPath = resolve(root, "apps/desktop/src-tauri/icons/icon.svg");
  await mkdir(resolve(iconPath, ".."), { recursive: true });
  await writeFile(iconPath, "<svg/>\n", "utf8");
  const drifted = await collectDesktopManifest({ repoRoot: root });
  assert.equal(drifted.clean, false);
  assert.equal(drifted.strictFailure, true, "every focused desktop asset is must-ship even when it is not a code extension");
  assert.deepEqual(drifted.untrackedFiles, ["apps/desktop/src-tauri/icons/icon.svg"]);
  await rm(resolve(root, "apps/desktop/ui/index.html"));
  const missing = await collectDesktopManifest({ repoRoot: root });
  assert.equal(missing.strictFailure, true);
  assert.deepEqual(missing.missingRequiredFiles, ["apps/desktop/ui/index.html"]);
});
test("delivery manifest is clean when physical focus files equal Git delivery set", async (t) => {
  const root = await createGitFixture();
  t.after(() => rmRetry(root));
  const manifest = await collectDeliveryManifest({
    repoRoot: root,
    focusPaths: ["apps/control-center/src", "apps/control-center/public", "apps/control-center/tests"],
  });
  assert.equal(manifest.clean, true);
  assert.equal(manifest.strictFailure, false);
  assert.match(renderDeliveryReport(manifest), /status: clean; strict: pass/);
});

test("delivery manifest excludes Git-ignored local artifacts from the delivery set", async (t) => {
  const root = await createGitFixture();
  t.after(() => rmRetry(root));
  await writeFile(resolve(root, ".gitignore"), "apps/control-center/public/scratch-preview-*.html\n", "utf8");
  await writeFile(
    resolve(root, "apps/control-center/public/scratch-preview-local.html"),
    "<!doctype html>\n",
    "utf8",
  );

  const manifest = await collectDeliveryManifest({
    repoRoot: root,
    focusPaths: ["apps/control-center/src", "apps/control-center/public", "apps/control-center/tests"],
  });
  assert.equal(manifest.clean, true);
  assert.equal(manifest.strictFailure, false);
  assert.ok(!manifest.physicalFiles.includes("apps/control-center/public/scratch-preview-local.html"));
  assert.ok(!manifest.untrackedFiles.includes("apps/control-center/public/scratch-preview-local.html"));
});

test("delivery manifest rejects focus paths outside repository root", async () => {
  await assert.rejects(
    collectDeliveryManifest({ repoRoot: process.cwd(), focusPaths: ["../outside"] }),
    /focus path escapes repository root/,
  );
});

test("delivery manifest CLI contract keeps report mode non-blocking and strict mode blocking", async (t) => {
  const root = await createGitFixture();
  t.after(() => rmRetry(root));
  await writeFile(resolve(root, "apps/control-center/src/untracked.mjs"), "export default false;\n", "utf8");
  const stdout = { value: "", write(chunk) { this.value += chunk; } };
  const stderr = { value: "", write(chunk) { this.value += chunk; } };

  assert.equal(await main([], { repoRoot: root, stdout, stderr }), 0);
  assert.match(stdout.value, /status: drift; strict: fail/);
  stdout.value = "";
  assert.equal(await main(["--strict", "--json"], { repoRoot: root, stdout, stderr }), 1);
  assert.equal(JSON.parse(stdout.value).strictFailure, true);
  assert.equal(await main(["--unknown"], { repoRoot: root, stdout, stderr }), 2);
  assert.match(stderr.value, /Unknown option/);
});

test("delivery manifest deduplicates repeated focus roots and rejects a symlinked root outside the repository", async (t) => {
  const root = await createGitFixture();
  t.after(() => rmRetry(root));
  const manifest = await collectDeliveryManifest({
    repoRoot: root,
    focusPaths: ["apps/control-center/src", "apps/control-center/src"],
  });
  assert.equal(manifest.focusPaths.length, 1);
  assert.equal(manifest.physicalFiles.length, 1);

  const outside = await mkdtemp(join(tmpdir(), "514cc-delivery-outside-"));
  t.after(() => rmRetry(outside));
  const linkPath = resolve(root, "apps/control-center/outside-link");
  const { symlink } = await import("node:fs/promises");
  await symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    collectDeliveryManifest({ repoRoot: root, focusPaths: ["apps/control-center/outside-link"] }),
    /focus path resolves outside repository root/,
  );
});

test("delivery ownership separates declared must-ship, intentional scratch, and undeclared source", async (t) => {
  const root = await createGitFixture();
  t.after(() => rmRetry(root));
  await writeFile(resolve(root, "apps/control-center/src/new.mjs"), "export default false;\n", "utf8");
  await writeFile(resolve(root, "apps/control-center/src/local-scratch.mjs"), "export default false;\n", "utf8");
  await writeFile(resolve(root, "apps/control-center/src/unowned.mjs"), "export default false;\n", "utf8");
  await writeFile(resolve(root, "apps/control-center/delivery-ownership.json"), `${JSON.stringify({
    schema: "514cc.delivery-ownership/v1",
    cut: { id: "fixture", formalRelease: false },
    rules: [
      { pattern: "apps/control-center/src/new.mjs", class: "must_ship", owner: "control-center", kind: "source" },
      { pattern: "apps/control-center/src/local-scratch.mjs", class: "scratch", owner: "qa", kind: "scratch" },
    ],
  }, null, 2)}\n`, "utf8");

  const manifest = await collectDeliveryManifest({
    repoRoot: root,
    focusPaths: ["apps/control-center/src"],
  });
  assert.deepEqual(manifest.ownership.intentionalUntracked, ["apps/control-center/src/local-scratch.mjs"]);
  assert.deepEqual(manifest.ownership.declaredMustShipSourceOrTests, ["apps/control-center/src/new.mjs"]);
  assert.deepEqual(manifest.ownership.undeclaredSourceOrTests, ["apps/control-center/src/unowned.mjs"]);
  assert.equal(manifest.strictFailure, true);
  const report = renderDeliveryReport(manifest);
  assert.match(report, /declared but untracked source\/test: 1[\s\S]*src\/new\.mjs/);
  assert.match(report, /undeclared source\/test: 1[\s\S]*src\/unowned\.mjs/);
  assert.equal(classifyOwnedPath("apps/control-center/src/local-scratch.mjs", manifest.ownership && {
    rules: [
      { pattern: "apps/control-center/src/new.mjs", class: "must_ship", owner: "control-center", kind: "source" },
      { pattern: "apps/control-center/src/local-scratch.mjs", class: "scratch", owner: "qa", kind: "scratch" },
    ],
  }).class, "scratch");
});

test("package-lock consistency rejects missing declared packages", () => {
  assert.equal(assertPackageLockConsistent(
    { name: "demo", dependencies: { leftpad: "1.0.0" } },
    { name: "demo", lockfileVersion: 3, packages: { "node_modules/leftpad": { version: "1.0.0" } } },
  ), true);
  assert.throws(
    () => assertPackageLockConsistent(
      { name: "demo", dependencies: { leftpad: "1.0.0" } },
      { name: "demo", lockfileVersion: 3, packages: {} },
    ),
    /missing declared packages/,
  );
});

test("delivery manifest CLI reports repository probe failures with exit code 2", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "514cc-delivery-not-git-"));
  t.after(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        return;
      } catch (error) {
        if (error?.code !== "EBUSY" || attempt === 4) return;
        await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
      }
    }
  });
  await writeFile(resolve(root, ".git"), "gitdir: missing-git-dir\n", "utf8");
  const stderr = { value: "", write(chunk) { this.value += chunk; } };
  const code = await main([], { repoRoot: root, stdout: { write() {} }, stderr });
  assert.equal(code, 2);
  assert.match(stderr.value, /delivery manifest failed/);
});
