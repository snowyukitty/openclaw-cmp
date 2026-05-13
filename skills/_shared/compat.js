import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");
const TMP_LOG_DIR = "/tmp/openclaw";

export function detectOpenClawVersion() {
  const result = spawnSync("openclaw", ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status !== 0) {
    return {
      raw: null,
      major: null,
      minor: null,
      patch: null,
    };
  }

  const raw = (result.stdout || result.stderr || "").trim();
  const match = raw.match(/OpenClaw\s+(\d{4})\.(\d+)\.(\d+)/i);
  return {
    raw,
    major: match ? Number(match[1]) : null,
    minor: match ? Number(match[2]) : null,
    patch: match ? Number(match[3]) : null,
  };
}

export async function latestGatewayLog() {
  try {
    const entries = await fs.readdir(TMP_LOG_DIR);
    const candidates = entries
      .filter((name) => /^openclaw-\d{4}-\d{2}-\d{2}\.log$/.test(name))
      .map((name) => path.join(TMP_LOG_DIR, name));
    const stats = await Promise.all(candidates.map(async (filePath) => ({
      filePath,
      stat: await fs.stat(filePath),
    })));
    stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    return stats[0]?.filePath || null;
  } catch {
    return null;
  }
}

export function managedBrowserHelpText() {
  const version = detectOpenClawVersion();
  const fallback = "Check CMP doctor output and the latest CMP run trace, then restart the gateway if browser control looks stale.";
  if (!version.raw) return fallback;
  if (version.major > 2026 || version.major === 2026 && version.minor >= 3) {
    return `${fallback} Newer OpenClaw builds may not expose \`openclaw browser ...\` in every interactive shell even when the managed browser runtime is available.`;
  }
  return "Start the managed browser with `openclaw browser start`, then retry `/cmp`.";
}

export async function readOpenClawConfig() {
  const configPath = path.join(OPENCLAW_DIR, "openclaw.json");
  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw);
}
