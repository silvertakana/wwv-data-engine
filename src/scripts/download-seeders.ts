import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

const GITHUB_PAT = process.env.GITHUB_PAT;
const SEEDERS_DIR = process.env.SEEDERS_DIR || path.resolve(process.cwd(), 'seeders');
const REPOS = [
  { owner: 'silvertakana', repo: 'wwv-seeders', targetDir: 'community' },
  { owner: 'silvertakana', repo: 'wwv-seeders-private', targetDir: 'private', private: true }
];

async function downloadRelease(owner: string, repo: string, isPrivate: boolean) {
  console.log(`[Downloader] Checking latest release for ${owner}/${repo}...`);
  
  if (isPrivate && !GITHUB_PAT) {
    console.warn(`[Downloader] Skipping private repo ${owner}/${repo} because GITHUB_PAT is not set.`);
    return;
  }

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'WWV-Data-Engine'
  };

  if (GITHUB_PAT) {
    headers['Authorization'] = `token ${GITHUB_PAT}`;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, { headers });
    
    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status} ${res.statusText}`);
    }

    const release = await res.json();
    const asset = release.assets?.find((a: any) => a.name === 'seeders.zip');

    if (!asset) {
      console.warn(`[Downloader] No seeders.zip found in the latest release of ${owner}/${repo}`);
      return;
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
    return Buffer.from(buffer);
  } catch (err) {
    console.error(`[Downloader] Error fetching release for ${owner}/${repo}:`, err);
    return null;
  }
}

export async function run() {
  if (!fs.existsSync(SEEDERS_DIR)) {
    fs.mkdirSync(SEEDERS_DIR, { recursive: true });
  }

  for (const { owner, repo, targetDir, private: isPrivate } of REPOS) {
    const zipBuffer = await downloadRelease(owner, repo, !!isPrivate);
    
    if (zipBuffer) {
      const targetPath = path.join(SEEDERS_DIR, targetDir);
      console.log(`[Downloader] Extracting ${owner}/${repo} to ${targetPath}...`);
      
      try {
        const zip = new AdmZip(zipBuffer);
        zip.extractAllTo(targetPath, true); // true = overwrite
        console.log(`[Downloader] Successfully extracted ${owner}/${repo}`);
      } catch (err) {
        console.error(`[Downloader] Failed to extract zip for ${owner}/${repo}:`, err);
      }
    }
  }
}

// If run directly
if (require.main === module) {
  run().catch(err => {
    console.error('[Downloader] Fatal error:', err);
    process.exit(1);
  });
}
