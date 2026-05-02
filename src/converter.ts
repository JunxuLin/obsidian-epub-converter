import { spawn, exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";
import * as https from "https";
import { EpubConverterSettings } from "./settings";

const execAsync = promisify(exec);

const RELEASES_API = "https://api.github.com/repos/JunxuLin/obsidian-epub-converter/releases/latest";

export interface ConversionProgress {
  onLog: (msg: string) => void;
  onDone: () => void;
  onError: (err: string) => void;
}

/** Pick the release asset name for the current platform/arch. Returns null if unsupported. */
export function platformAssetName(): string | null {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "markitdown-macos-arm64";
  if (platform === "darwin" && arch === "x64")  return "markitdown-macos-x64";
  if (platform === "win32")                      return "markitdown-windows-x64.exe";
  if (platform === "linux" && arch === "x64")    return "markitdown-linux-x64";
  return null;
}

/** Absolute path where the bundled binary lives inside the plugin folder. */
export function binaryPath(pluginDir: string): string {
  const name = process.platform === "win32" ? "markitdown.exe" : "markitdown";
  return path.join(pluginDir, "bin", name);
}

/** Check if the markitdown binary is present and runnable. */
export async function checkBinaryInstalled(pluginDir: string): Promise<{ installed: boolean; version?: string }> {
  const bin = binaryPath(pluginDir);
  if (!fs.existsSync(bin)) return { installed: false };
  // Verify it's a real executable (non-empty file with execute permission)
  try {
    const stat = fs.statSync(bin);
    if (stat.size < 1000) return { installed: false }; // suspiciously small
    if (process.platform !== "win32") {
      fs.accessSync(bin, fs.constants.X_OK);
    }
  } catch {
    return { installed: false };
  }
  // Best-effort version string (don't fail if subprocess can't run)
  try {
    const { stdout } = await execAsync(`"${bin}" --version`, { timeout: 5000 });
    return { installed: true, version: stdout.trim() };
  } catch {
    // Binary exists and is executable even if --version has issues
    return { installed: true };
  }
}

/** Download with redirect following, saving to destPath with progress. */
function downloadFile(url: string, destPath: string, onLog: (msg: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const doGet = (u: string) => {
      https.get(u, { headers: { "User-Agent": "obsidian-epub-converter" } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          doGet(res.headers.location!);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const total = parseInt(res.headers["content-length"] ?? "0", 10);
        let received = 0;
        const file = fs.createWriteStream(destPath);
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (total > 0) {
            const pct = Math.round((received / total) * 100);
            onLog(`Downloading markitdown… ${pct}% (${Math.round(received / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB)`);
          }
        });
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
        file.on("error", reject);
        res.on("error", reject);
      }).on("error", reject);
    };
    doGet(url);
  });
}

/** Fetch the latest release from GitHub and return the download URL for the current platform. */
async function getLatestDownloadUrl(assetName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(RELEASES_API, { headers: { "User-Agent": "obsidian-epub-converter" } }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          const asset = (data.assets as any[]).find((a: any) => a.name === assetName);
          if (!asset) reject(new Error(`Asset "${assetName}" not found in latest release`));
          else resolve(asset.browser_download_url);
        } catch (e) {
          reject(e);
        }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

/** Download the markitdown binary for the current platform into <pluginDir>/bin/. */
export async function downloadBinary(pluginDir: string, onLog: (msg: string) => void): Promise<void> {
  const assetName = platformAssetName();
  if (!assetName) {
    throw new Error(
      `Unsupported platform: ${process.platform}/${process.arch}. ` +
      `Pre-built binaries are available for macOS (arm64), Windows (x64). ` +
      `Please open an issue at https://github.com/JunxuLin/obsidian-epub-converter`
    );
  }

  onLog("Checking latest release…");
  const downloadUrl = await getLatestDownloadUrl(assetName);
  onLog(`Found: ${assetName}`);

  const binDir = path.join(pluginDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const dest = binaryPath(pluginDir);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);

  await downloadFile(downloadUrl, dest, onLog);

  if (process.platform !== "win32") {
    fs.chmodSync(dest, 0o755);
  }

  onLog("✓ markitdown binary ready.");
}

/** Run the markitdown conversion and stream output back. */
export async function runConversion(
  epubPath: string,
  outputDir: string,
  settings: EpubConverterSettings,
  pluginDir: string,
  progress: ConversionProgress
): Promise<void> {
  const bin = binaryPath(pluginDir);

  if (!fs.existsSync(bin)) {
    progress.onError("[EC-004] markitdown binary not found. Please go to EPUB Converter settings and click Download.");
    return;
  }

  const args: string[] = [
    epubPath,
    "--split-by-chapter", outputDir,
    "--save-images", outputDir,
  ];

  progress.onLog(`Running: markitdown ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);

    child.stdout.on("data", (data: Buffer) => {
      progress.onLog(data.toString().trim());
    });

    child.stderr.on("data", (data: Buffer) => {
      progress.onLog(data.toString().trim());
    });

    child.on("close", (code: number) => {
      if (code === 0) {
        progress.onDone();
        resolve();
      } else {
        const msg = `markitdown exited with code ${code}`;
        progress.onError(msg);
        reject(new Error(msg));
      }
    });

    child.on("error", (err: Error) => {
      progress.onError(err.message);
      reject(err);
    });
  });
}

/** Derive a safe output folder name from an epub path, avoiding conflicts. */
export function deriveOutputFolder(
  epubPath: string,
  vaultBooksDir: string,
  onConflict: "ask" | "rename" | "overwrite"
): string {
  const stem = path.basename(epubPath, path.extname(epubPath));
  const base = path.join(vaultBooksDir, stem);

  if (onConflict !== "rename" || !fs.existsSync(base)) {
    return base;
  }

  let n = 2;
  while (fs.existsSync(`${base} (${n})`)) {
    n++;
  }
  return `${base} (${n})`;
}
