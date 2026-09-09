import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** The running server's build stamp, reported by GET /health. */
export interface BuildInfo {
  version: string;
  build: string;
  commit: string;
  builtAt?: string;
}

let cached: BuildInfo | null = null;

const readMaybe = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/**
 * Build stamp of the running server: semver from package.json, build number +
 * short commit from dist/build-info.json (written by scripts/build-info.mjs at
 * build time). Falls back to safe defaults for a from-source run (tests, dev)
 * where build-info.json does not exist, so the shape is always well-formed.
 */
export function getBuildInfo(): BuildInfo {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));

  let version = '0.0.0';
  const pkgRaw = readMaybe(join(here, '..', 'package.json'));
  if (pkgRaw) {
    try {
      const v = (JSON.parse(pkgRaw) as { version?: string }).version;
      if (v) version = v;
    } catch {
      /* keep default */
    }
  }

  let build = '0';
  let commit = 'dev';
  let builtAt: string | undefined;
  const biRaw = readMaybe(join(here, 'build-info.json'));
  if (biRaw) {
    try {
      const bi = JSON.parse(biRaw) as Partial<BuildInfo>;
      if (bi.version) version = bi.version;
      if (bi.build) build = bi.build;
      if (bi.commit) commit = bi.commit;
      builtAt = bi.builtAt;
    } catch {
      /* keep defaults */
    }
  }

  cached = { version, build, commit, builtAt };
  return cached;
}

/** Reset the memoised value (tests only). */
export function _resetBuildInfoCache(): void {
  cached = null;
}
