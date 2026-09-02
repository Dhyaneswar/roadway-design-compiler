import { defineConfig } from "vite";
import { execSync } from "node:child_process";

/**
 * Stamp the build so a served page can say WHICH build it is.
 *
 * Independent QA on 2026-08-31 recorded "Served code commit/build ID:
 * unknown/not exposed by the tool surface" and had to fingerprint the tool
 * catalogue by hash instead. That fingerprints the contract, not the binary --
 * two different builds with the same tool shapes are indistinguishable, so a
 * tester cannot tell whether a fix is deployed and a green result cannot be
 * attributed to a commit. read_design now reports these.
 *
 * Both fall back to "unknown" rather than failing the build: a tree exported by
 * `git archive` has no .git directory, and a build that dies outside a checkout
 * would be a worse failure than an unstamped one.
 */
/**
 * Returns the command's output, or undefined if it could not run.
 *
 * ⚠ Empty output and failure are DIFFERENT and must not be collapsed. An earlier
 * version returned "unknown" for both, and since a clean tree makes
 * `git status --porcelain` print nothing, every build from a clean checkout was
 * stamped -dirty. A build identifier that is wrong is worse than none.
 */
function sh(cmd: string): string | undefined {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return undefined;
  }
}

const head = sh("git rev-parse --short HEAD");
const status = sh("git status --porcelain");
const commit = head === undefined || head === "" ? "unknown" : head;
const dirty = commit !== "unknown" && status !== undefined && status !== "";

export default defineConfig({
  define: {
    __BUILD_COMMIT__: JSON.stringify(dirty ? `${commit}-dirty` : commit),
    __BUILD_AT__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    /**
     * Raised only AFTER the initial bundle was actually made small.
     *
     * The entry chunk was 772 KB because `studio/main.ts` imported the three.js
     * viewer statically, so every first paint -- and every agent that only ever
     * reads the design -- downloaded a 3D renderer it might never open.
     * `activate3d()` now imports it dynamically, which is what the 500 KB
     * default was warning about: entry 222 KB, renderer 550 KB fetched on the
     * first click of the 3D tab.
     *
     * ⚠ The remaining chunk over the default is three.js itself, and it is
     * DEFERRED. The threshold is lifted to stop a warning that no longer
     * describes a problem -- not to silence one.
     *
     * ⛔ This setting only prints; it fails neither Vite nor CI. An earlier
     * version of this comment said an oversize entry "should fail loudly",
     * which was an aspiration written as a fact. The actual guard is
     * `scripts/check-bundle-size.mjs`, which asserts the ENTRY chunk against a
     * budget and exits non-zero -- run by `npm run check:bundle` and by CI.
     */
    chunkSizeWarningLimit: 600,
  },
});
