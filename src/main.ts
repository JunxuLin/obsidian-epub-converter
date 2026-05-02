import {
  App,
  FileSystemAdapter,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  addIcon,
} from "obsidian";
import * as path from "path";
import * as fs from "fs";
import { EpubConverterSettings, DEFAULT_SETTINGS } from "./settings";
import {
  checkBinaryInstalled,
  deriveOutputFolder,
  downloadBinary,
  runConversion,
} from "./converter";
import { Logger } from "./logger";

// ── Error codes ───────────────────────────────────────────────────────────────
export const ERR = {
  NO_FILE_SELECTED:    "EC-001",  // File picker closed with no selection
  FILE_PATH_MISSING:   "EC-002",  // Electron did not return a file path
  FILE_NOT_FOUND:      "EC-003",  // epub path does not exist on disk
  BINARY_NOT_FOUND:    "EC-004",  // markitdown binary missing from plugin dir
  DOWNLOAD_FAILED:     "EC-005",  // downloading binary from GitHub failed
  CONVERSION_FAILED:   "EC-006",  // markitdown exited non-zero
  UNSUPPORTED_PLATFORM:"EC-007",  // no binary for this OS/arch
  OUTPUT_DIR_FAILED:   "EC-008",  // could not create output directory
  UNKNOWN:             "EC-099",  // unexpected error
} as const;

function fmtErr(code: string, msg: string) {
  return `[${code}] ${msg}`;
}

// ── ribbon icon (book svg) ──────────────────────────────────────────────────
const BOOK_ICON_ID = "epub-converter-book";
addIcon(
  BOOK_ICON_ID,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
  </svg>`
);

// ── plugin ──────────────────────────────────────────────────────────────────
export default class EpubConverterPlugin extends Plugin {
  settings!: EpubConverterSettings;
  logger!: Logger;
  /** Cached result from startup binary check — avoids re-running on every settings open */
  binaryInstalled = false;

  async onload() {
    await this.loadSettings();

    // Initialise logger — cleans old entries on startup
    this.logger = new Logger(this.pluginDir(), this.settings.debugLog);
    this.logger.cleanOldEntries();
    this.logger.info("Plugin loaded");

    // Ribbon icon – open "Import EPUB" dialog
    this.addRibbonIcon(BOOK_ICON_ID, "EPUB Converter: Import EPUB", () => {
      new ImportEpubModal(this.app, this).open();
    });

    // Command palette
    this.addCommand({
      id: "import-epub",
      name: "Import EPUB",
      callback: () => new ImportEpubModal(this.app, this).open(),
    });

    // Right-click menu on .epub files inside the vault
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TFile) => {
        if (!(file instanceof TFile) || file.extension !== "epub") return;
        menu.addItem((item) => {
          item
            .setTitle("Import EPUB with EPUB Converter")
            .setIcon(BOOK_ICON_ID)
            .onClick(() => this.convertEpub(file.path));
        });
      })
    );

    this.addSettingTab(new EpubConverterSettingTab(this.app, this));

    // Check binary once at startup, cache result
    await this._autoInstallIfNeeded();
  }

  /** Show a notice AND write it to the log. */
  notify(msg: string, level: "INFO" | "WARN" | "ERROR" = "INFO", timeoutMs = 4000) {
    new Notice(msg, timeoutMs);
    this.logger.log(level, msg);
  }

  /** Download markitdown binary in the background on first use, without blocking startup. */
  private async _autoInstallIfNeeded() {
    const pluginDir = this.pluginDir();
    const { installed } = await checkBinaryInstalled(pluginDir);
    this.binaryInstalled = installed;
    if (installed) {
      this.logger.info("Binary check: markitdown already installed");
      return;
    }

    this.logger.info("Binary not found — starting auto-download");
    const notice = new Notice("📚 EPUB Converter: Downloading markitdown… (first-time setup)", 0);
    try {
      await downloadBinary(pluginDir, (msg) => {
        notice.setMessage(`📚 EPUB Converter: ${msg}`);
        this.logger.info(`Download: ${msg}`);
      });
      notice.hide();
      this.binaryInstalled = true;
      this.notify("📚 EPUB Converter: markitdown ready ✅");
    } catch (e) {
      notice.hide();
      this.notify(
        `❌ ${fmtErr(ERR.DOWNLOAD_FAILED, (e as Error).message)} — Open Settings → EPUB Converter to retry.`,
        "ERROR",
        15000
      );
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Convert an epub path (vault-relative or absolute) */
  async convertEpub(epubVaultRelOrAbsolute: string) {
    if (!epubVaultRelOrAbsolute) {
      this.notify(`❌ ${fmtErr(ERR.FILE_PATH_MISSING, "No file path received from picker.")}`, "ERROR", 8000);
      return;
    }

    const vaultRoot = (this.app.vault.adapter as any).getBasePath?.() ?? "";
    const epubAbsolute = path.isAbsolute(epubVaultRelOrAbsolute)
      ? epubVaultRelOrAbsolute
      : path.join(vaultRoot, epubVaultRelOrAbsolute);

    this.logger.info(`Convert requested: ${epubAbsolute}`);

    if (!fs.existsSync(epubAbsolute)) {
      this.notify(`❌ ${fmtErr(ERR.FILE_NOT_FOUND, `File not found: ${epubAbsolute}`)}`, "ERROR", 10000);
      return;
    }

    let booksDir: string;
    try {
      booksDir = path.join(vaultRoot, this.settings.outputFolder);
      fs.mkdirSync(booksDir, { recursive: true });
    } catch (e) {
      this.notify(`❌ ${fmtErr(ERR.OUTPUT_DIR_FAILED, `Cannot create output folder: ${(e as Error).message}`)}`, "ERROR", 10000);
      return;
    }

    const outputDir = deriveOutputFolder(epubAbsolute, booksDir, this.settings.onConflict);

    if (this.settings.onConflict === "ask" && fs.existsSync(outputDir)) {
      this.logger.info(`Conflict detected for output dir: ${outputDir}`);
      new ConflictModal(this.app, outputDir, async (choice) => {
        this.logger.info(`Conflict resolved: ${choice}`);
        if (choice === "rename") {
          const alt = deriveOutputFolder(epubAbsolute + "_", booksDir, "rename");
          await this._runConversion(epubAbsolute, alt);
        } else if (choice === "overwrite") {
          await this._runConversion(epubAbsolute, outputDir);
        }
      }).open();
      return;
    }

    await this._runConversion(epubAbsolute, outputDir);
  }

  private pluginDir(): string {
    const adapter = this.app.vault.adapter;
    const dir = this.manifest.dir ?? ".obsidian/plugins/epub-converter";
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getFullPath(dir);
    }
    return path.join((adapter as any).getBasePath?.() ?? "", dir);
  }

  private async _runConversion(epubAbsolute: string, outputDir: string) {
    const pluginDir = this.pluginDir();
    const startTime = Date.now();
    const notice = new Notice(`📚 Importing "${path.basename(epubAbsolute)}"…`, 0);

    const elapsed = () => {
      const s = ((Date.now() - startTime) / 1000).toFixed(1);
      return `${s}s`;
    };

    this.logger.info(`Conversion started: ${path.basename(epubAbsolute)} → ${outputDir}`);

    try {
      await runConversion(
        epubAbsolute,
        outputDir,
        this.settings,
        pluginDir,
        {
          onLog: (msg) => {
            this.logger.info(`markitdown: ${msg}`);
            notice.setMessage(`📚 Importing "${path.basename(epubAbsolute)}"… (${elapsed()})`);
          },
          onDone: () => {
            const msg = `✅ Import complete: ${path.basename(outputDir)} — took ${elapsed()}`;
            notice.hide();
            this.notify(msg);
            this.logger.info(`Conversion done in ${elapsed()}: ${outputDir}`);
            this._refreshVault(outputDir);
          },
          onError: (errMsg) => {
            const msg = `❌ ${fmtErr(ERR.CONVERSION_FAILED, errMsg)} (after ${elapsed()})`;
            notice.hide();
            this.notify(msg, "ERROR", 10000);
          },
        }
      );
    } catch (e) {
      const msg = `❌ ${fmtErr(ERR.UNKNOWN, (e as Error).message)} (after ${elapsed()})`;
      notice.hide();
      this.notify(msg, "ERROR", 10000);
    }
  }

  private async _refreshVault(outputDir: string) {
    // Give the filesystem a moment, then ask Obsidian to reconcile
    setTimeout(async () => {
      try {
        const adapter = this.app.vault.adapter as any;
        if (typeof adapter.reconcile === "function") {
          await adapter.reconcile();
        }
        // Open README.md if it exists
        const vaultRoot = adapter.getBasePath?.() ?? "";
        const relative = path.relative(vaultRoot, path.join(outputDir, "README.md"));
        const readme = this.app.vault.getFileByPath
          ? this.app.vault.getFileByPath(relative)
          : (this.app.vault as any).getAbstractFileByPath?.(relative);
        if (readme instanceof TFile) {
          this.app.workspace.getLeaf().openFile(readme);
        }
      } catch {
        // best-effort
      }
    }, 1000);
  }
}

// ── "Import EPUB" modal ──────────────────────────────────────────────────────
class ImportEpubModal extends Modal {
  plugin: EpubConverterPlugin;

  constructor(app: App, plugin: EpubConverterPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Import EPUB" });
    contentEl.createEl("p", {
      text: "Select an EPUB file from your computer to import it into your vault as Markdown.",
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Browse…")
        .setCta()
        .onClick(async () => {
          try {
            // Use Electron's native dialog for reliable absolute paths
            const { remote } = require("electron");
            const result = await remote.dialog.showOpenDialog({
              properties: ["openFile"],
              filters: [{ name: "EPUB files", extensions: ["epub"] }],
            });
            if (result.canceled || result.filePaths.length === 0) return;
            const filePath = result.filePaths[0];
            this.close();
            await this.plugin.convertEpub(filePath);
          } catch (e) {
            this.plugin.notify(`❌ ${fmtErr(ERR.FILE_PATH_MISSING, `Could not open file dialog: ${(e as Error).message}`)}`, "ERROR", 10000);
          }
        })
    );

    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText("Cancel").onClick(() => this.close())
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ── Conflict modal ───────────────────────────────────────────────────────────
class ConflictModal extends Modal {
  callback: (choice: "rename" | "overwrite" | "cancel") => void;
  outputDir: string;

  constructor(
    app: App,
    outputDir: string,
    callback: (choice: "rename" | "overwrite" | "cancel") => void
  ) {
    super(app);
    this.outputDir = outputDir;
    this.callback = callback;
  }

  onOpen() {
    const { contentEl } = this;
    const name = path.basename(this.outputDir);
    contentEl.createEl("h2", { text: "Folder already exists" });
    contentEl.createEl("p", {
      text: `"${name}" already exists in your vault. What should EPUB Converter do?`,
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Rename (keep both)").onClick(() => {
          this.close();
          this.callback("rename");
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Overwrite").onClick(() => {
          this.close();
          this.callback("overwrite");
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.close();
          this.callback("cancel");
        })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ── Settings tab ─────────────────────────────────────────────────────────────
class EpubConverterSettingTab extends PluginSettingTab {
  plugin: EpubConverterPlugin;

  constructor(app: App, plugin: EpubConverterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "EPUB Converter" });

    // ── markitdown binary — only shown when not yet installed ────────────────
    if (!this.plugin.binaryInstalled) {
      containerEl.createEl("h3", { text: "markitdown binary" });
      const statusEl = containerEl.createEl("p", {
        text: "⏳ markitdown not yet downloaded — click Download or restart Obsidian to trigger auto-download.",
      });

      const pluginDir = this.pluginDir();
      new Setting(containerEl)
        .setName("Download markitdown")
        .setDesc("Downloads the pre-built markitdown binary from the latest GitHub release. No Python required.")
        .addButton((btn) =>
          btn
            .setButtonText("Download")
            .setCta()
            .onClick(async () => {
              btn.setDisabled(true);
              btn.setButtonText("Downloading…");
              const notice = new Notice("Downloading markitdown…", 0);
              try {
                await downloadBinary(pluginDir, (msg) => {
                  notice.setMessage(msg);
                  this.plugin.logger.info(`Download: ${msg}`);
                });
                notice.hide();
                this.plugin.binaryInstalled = true;
                this.plugin.notify("✅ markitdown ready");
                // Refresh settings to hide this section
                this.display();
              } catch (e) {
                notice.hide();
                statusEl.setText(`❌ Download failed: ${(e as Error).message}`);
                this.plugin.notify(`❌ Download failed: ${(e as Error).message}`, "ERROR", 10000);
                btn.setDisabled(false);
                btn.setButtonText("Retry");
              }
            })
        );
    }

    // ── Output ──────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Output" });

    new Setting(containerEl)
      .setName("Books folder")
      .setDesc("Vault-relative folder where imported books are saved.")
      .addText((text) =>
        text
          .setPlaceholder("Books")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim() || "Books";
            await this.plugin.saveSettings();
          })
      );

    // ── Conflicts ───────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Conflicts" });

    new Setting(containerEl)
      .setName("If book folder already exists")
      .addDropdown((drop) =>
        drop
          .addOption("rename", "Rename (keep both)")
          .addOption("overwrite", "Overwrite")
          .addOption("ask", "Ask me")
          .setValue(this.plugin.settings.onConflict)
          .onChange(async (value: string) => {
            this.plugin.settings.onConflict = value as "ask" | "rename" | "overwrite";
            await this.plugin.saveSettings();
          })
      );

    // ── Debug log ────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Debug log" });

    new Setting(containerEl)
      .setName("Enable debug log")
      .setDesc("Write plugin activity to epub-converter.log in the plugin folder. Auto-cleaned weekly.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugLog)
          .onChange(async (value) => {
            this.plugin.settings.debugLog = value;
            this.plugin.logger.setEnabled(value);
            await this.plugin.saveSettings();
          })
      );

    const logPath = this.plugin.logger.getLogPath();
    new Setting(containerEl)
      .setName("Open log file")
      .setDesc(logPath)
      .addButton((btn) =>
        btn.setButtonText("Open").onClick(() => {
          if (!fs.existsSync(logPath)) {
            new Notice("Log file has no entries yet.");
            return;
          }
          const { shell } = require("electron");
          shell.openPath(logPath);
        })
      );
  }

  private pluginDir(): string {
    const adapter = this.plugin.app.vault.adapter;
    const dir = this.plugin.manifest.dir ?? ".obsidian/plugins/epub-converter";
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getFullPath(dir);
    }
    return path.join((adapter as any).getBasePath?.() ?? "", dir);
  }
}
