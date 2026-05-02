import * as fs from "fs";
import * as path from "path";

const LOG_FILE = "epub-converter.log";
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Keep log file from growing unbounded — trim to this many lines max
const MAX_LINES = 5000;

export class Logger {
  private logPath: string;
  private enabled: boolean;

  constructor(pluginDir: string, enabled: boolean) {
    this.logPath = path.join(pluginDir, LOG_FILE);
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  getLogPath(): string {
    return this.logPath;
  }

  log(level: "INFO" | "WARN" | "ERROR", msg: string) {
    if (!this.enabled) return;
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    try {
      fs.appendFileSync(this.logPath, line, "utf8");
    } catch {
      // Best-effort — never crash the plugin over logging
    }
  }

  info(msg: string)  { this.log("INFO",  msg); }
  warn(msg: string)  { this.log("WARN",  msg); }
  error(msg: string) { this.log("ERROR", msg); }

  /** Remove log lines older than 1 week, and trim to MAX_LINES. Called on startup. */
  cleanOldEntries() {
    if (!fs.existsSync(this.logPath)) return;
    try {
      const raw = fs.readFileSync(this.logPath, "utf8");
      const cutoff = Date.now() - ONE_WEEK_MS;
      const lines = raw.split("\n").filter((line) => {
        if (!line.trim()) return false;
        // Parse ISO timestamp from start of line: [2024-01-01T...]
        const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
        if (!m) return true; // keep lines we can't parse
        return new Date(m[1]).getTime() >= cutoff;
      });
      // Also cap total size
      const trimmed = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
      fs.writeFileSync(this.logPath, trimmed.join("\n") + (trimmed.length ? "\n" : ""), "utf8");
    } catch {
      // Best-effort
    }
  }
}
