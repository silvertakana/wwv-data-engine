import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { execSync } from 'child_process';

const SEEDERS_DIR = process.env.SEEDERS_DIR || path.resolve(process.cwd(), 'seeders');

// Sentinel for "private repo skipped because no PAT". A skip is a legitimate
// outcome (the engine runs on public seeders alone), not a sync failure.
const PRIVATE_SKIP_REASON = 'no GITHUB_PAT';

interface GitHubReleaseAsset {
  name: string;
  url: string;
}

interface GitHubRelease {
  tag_name?: string;
  assets?: GitHubReleaseAsset[];
}

// Per-repo outcome of one download+extract pass, published to /health so
// operators can tell a skipped private sync apart from a genuine failure.
export interface SeederSyncRepoState {
  ok: boolean;
  packages: number;
  error: string | null;
}

// Module-level sync state, mutated in place by run(). /health spreads it
// verbatim and /health/seeders derives its 200/503 verdict from it.
export interface SeederSyncState {
  ok: boolean | null;
  lastAttemptAt: number | null;
  community: SeederSyncRepoState;
  private: SeederSyncRepoState;
  mergedCount: number;
}

export const seederSync: SeederSyncState = {
  ok: null,
  lastAttemptAt: null,
  community: { ok: false, packages: 0, error: null },
  private: { ok: false, packages: 0, error: null },
  mergedCount: 0,
};

// Overall verdict: the community repo is mandatory; the private repo only
// matters when a PAT is configured. A private skip (no GITHUB_PAT) counts as
// healthy, so an engine deployed without a PAT still reports a green sync.
export function computeSeederSyncOk(
  community: SeederSyncRepoState,
  privateRepo: SeederSyncRepoState,
): boolean {
  return community.ok && (privateRepo.ok || privateRepo.error === PRIVATE_SKIP_REASON);
}

interface RepoSpec {
  owner: string;
  repo: string;
  targetDir: string;
  private?: boolean;
}

function parseRepoSpec(spec: string): { owner: string; repo: string } {
  const slash = spec.indexOf('/');
  if (slash === -1) return { owner: 'silvertakana', repo: spec };
  return { owner: spec.slice(0, slash), repo: spec.slice(slash + 1) };
}

// Repo specs resolve at run() time so forks/mirrors can be injected through
// env without rebuilding the image.
function resolveRepos(): RepoSpec[] {
  const communitySpec = process.env.COMMUNITY_SEEDERS_REPO || 'silvertakana/wwv-seeders';
  const privateSpec = process.env.PRIVATE_SEEDERS_REPO || 'silvertakana/wwv-seeders-private';
  return [
    { ...parseRepoSpec(communitySpec), targetDir: 'community' },
    { ...parseRepoSpec(privateSpec), targetDir: 'private', private: true },
  ];
}

type DownloadResult =
  | { kind: 'zip'; buffer: Buffer }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; message: string };

async function downloadRelease(
  owner: string,
  repo: string,
  isPrivate: boolean,
  githubPat: string | undefined,
): Promise<DownloadResult> {
  console.log(`[Downloader] Checking latest release for ${owner}/${repo}...`);

  if (isPrivate && !githubPat) {
    console.warn(`[Downloader] Skipping private repo ${owner}/${repo} because GITHUB_PAT is not set.`);
    return { kind: 'skipped', reason: PRIVATE_SKIP_REASON };
  }

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'WWV-Data-Engine'
  };

  if (githubPat) {
    headers['Authorization'] = `token ${githubPat}`;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, { headers });

    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status} ${res.statusText}`);
    }

    const release = (await res.json()) as GitHubRelease;
    const asset = release.assets?.find((a) => a.name === 'seeders.zip');

    if (!asset) {
      console.warn(`[Downloader] No seeders.zip found in the latest release of ${owner}/${repo}`);
      return { kind: 'error', message: 'No seeders.zip in latest release' };
    }

    console.log(`[Downloader] Found seeders.zip for ${owner}/${repo} (${release.tag_name}). Downloading...`);

    const assetRes = await fetch(asset.url, {
      headers: {
        ...headers,
        'Accept': 'application/octet-stream'
      }
    });

    if (!assetRes.ok) {
      throw new Error(`Failed to download asset: ${assetRes.status} ${assetRes.statusText}`);
    }

    const buffer = await assetRes.arrayBuffer();
    return { kind: 'zip', buffer: Buffer.from(buffer) };
  } catch (err) {
    console.error(`[Downloader] Error fetching release for ${owner}/${repo}:`, err);
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

// The workspace glob is "community/*", so each package is exactly one top-level
// directory inside the target dir.
function countPackages(dir: string): number {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}

export async function run() {
  // Reset to a fresh pass. Fields are mutated in place because routes.ts holds
  // the same object reference; reassigning the module export would orphan a
  // CJS consumer (tsx/vitest) on a stale object.
  seederSync.lastAttemptAt = Date.now();
  seederSync.ok = null;
  seederSync.community = { ok: false, packages: 0, error: null };
  seederSync.private = { ok: false, packages: 0, error: null };
  seederSync.mergedCount = 0;

  if (!fs.existsSync(SEEDERS_DIR)) {
    fs.mkdirSync(SEEDERS_DIR, { recursive: true });
  }

  let extractedSomething = false;
  const githubPat = process.env.GITHUB_PAT;

  for (const { owner, repo, targetDir, private: isPrivate } of resolveRepos()) {
    const repoState = isPrivate ? seederSync.private : seederSync.community;
    const download = await downloadRelease(owner, repo, !!isPrivate, githubPat);

    if (download.kind === 'skipped' || download.kind === 'error') {
      repoState.error = download.kind === 'skipped' ? download.reason : download.message;
      continue;
    }

    const targetPath = path.join(SEEDERS_DIR, targetDir);

    // Wipe the target dir before extracting. extractAllTo overwrites files
    // present in the zip but does NOT delete files that existed locally and
    // were removed in the new release. Without this, deleted seeders (e.g.
    // moving maritime from private to community) persist on the volume
    // forever and run as duplicates alongside the canonical copy.
    if (fs.existsSync(targetPath)) {
      console.log(`[Downloader] Wiping stale ${targetPath} before extracting fresh release...`);
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    fs.mkdirSync(targetPath, { recursive: true });

    console.log(`[Downloader] Extracting ${owner}/${repo} to ${targetPath}...`);

    try {
      const zip = new AdmZip(download.buffer);
      zip.extractAllTo(targetPath, true);
      console.log(`[Downloader] Successfully extracted ${owner}/${repo}`);
      repoState.ok = true;
      repoState.packages = countPackages(targetPath);
      extractedSomething = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      repoState.error = `Failed to extract zip: ${message}`;
      console.error(`[Downloader] Failed to extract zip for ${owner}/${repo}:`, err);
    }
  }

  if (extractedSomething) {
    // 1. Generate root package.json for the workspace
    const rootPackageJsonPath = path.join(SEEDERS_DIR, 'package.json');
    fs.writeFileSync(rootPackageJsonPath, JSON.stringify({
      name: "wwv-seeders-workspace",
      version: "1.0.0",
      private: true
    }, null, 2));
    console.log(`[Downloader] Generated root package.json at ${rootPackageJsonPath}`);

    // 2. Generate pnpm-workspace.yaml
    const workspaceYamlPath = path.join(SEEDERS_DIR, 'pnpm-workspace.yaml');
    const workspaceYamlContent = `packages:\n  - "community/*"\n  - "private/*"\n`;
    fs.writeFileSync(workspaceYamlPath, workspaceYamlContent);
    console.log(`[Downloader] Generated pnpm-workspace.yaml at ${workspaceYamlPath}`);
    // 3. Install all dependencies across the workspace
    console.log(`[Downloader] Installing production workspace dependencies...`);
    try {
      execSync('pnpm install --prod', { cwd: SEEDERS_DIR, stdio: 'inherit' });
      console.log(`[Downloader] Workspace installation successful.`);
    } catch (installErr) {
      // The install step is shared by both repos; attribute the failure to the
      // mandatory community repo so the overall verdict flips to failed.
      const message = installErr instanceof Error ? installErr.message : String(installErr);
      seederSync.community.ok = false;
      seederSync.community.error = `Workspace install failed: ${message}`;
      console.error(`[Downloader] Failed to install workspace dependencies:`, installErr);
    }
  }

  seederSync.mergedCount = seederSync.community.packages + seederSync.private.packages;
  seederSync.ok = computeSeederSyncOk(seederSync.community, seederSync.private);
}

// If run directly. Guarded because vitest/vite import this module as ESM where
// `require` is undefined and would throw a ReferenceError at import time.
if (typeof require !== 'undefined' && require.main === module) {
  run().catch(err => {
    console.error('[Downloader] Fatal error:', err);
    process.exit(1);
  });
}