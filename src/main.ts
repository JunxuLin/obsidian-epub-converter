import {
  App,
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

  async onload() {
    await this.loadSettings();

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

    // Auto-install markitdown if not yet present
    this._autoInstallIfNeeded();
  }

  /** Download markitdown binary in the background on first use, without blocking startup. */
  private async _autoInstallIfNeeded() {
    const pluginDir = this.pluginDir();
    const { installed } = await checkBinaryInstalled(pluginDir);
    if (installed) return;

    const notice = new Notice("📚 EPUB Converter: Downloading markitdown… (first-time setup)", 0);
    try {
      await downloadBinary(pluginDir, (msg) => {
        notice.setMessage(`📚 EPUB Converter: ${msg}`);
      });
      notice.hide();
      new Notice("📚 EPUB Converter: markitdown ready ✅");
    } catch (e) {
      notice.hide();
      new Notice(
        `📚 EPUB Converter: Auto-download failed — ${(e as Error).message}. Open Settings → EPUB Converter to retry.`,
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
    const vaultRoot = (this.app.vault.adapter as any).getBasePath?.() ?? "";
    const epubAbsolute = path.isAbsolute(epubVaultRelOrAbsolute)
      ? epubVaultRelOrAbsolute
      : path.join(vaultRoot, epubVaultRelOrAbsolute);

    const booksDir = path.join(vaultRoot, this.settings.outputFolder);
    fs.mkdirSync(booksDir, { recursive: true });

    const outputDir = deriveOutputFolder(
      epubAbsolute,
      booksDir,
      this.settings.onConflict
    );

    if (this.settings.onConflict === "ask" && fs.existsSync(outputDir)) {
      new ConflictModal(this.app, outputDir, async (choice) => {
        if (choice === "rename") {
          const alt = deriveOutputFolder(epubAbsolute + "_", booksDir, "rename");
          await this._runConversion(epubAbsolute, alt);
        } else if (choice === "overwrite") {
          await this._runConversion(epubAbsolute, outputDir);
        }
        // else: cancel – do nothing
      }).open();
      return;
    }

    await this._runConversion(epubAbsolute, outputDir);
  }

  private pluginDir(): string {
    return path.join(
      (this.app.vault.adapter as any).getBasePath?.() ?? "",
      ".obsidian",
      "plugins",
      "epub-converter"
    );
  }

  private async _runConversion(epubAbsolute: string, outputDir: string) {
    const notice = new Notice(`📚 Importing "${path.basename(epubAbsolute)}"…`, 0);

    try {
      await runConversion(
        epubAbsolute,
        outputDir,
        this.settings,
        this.pluginDir(),
        {
          onLog: (msg) => console.log("[EPUB Converter]", msg),
          onDone: () => {
            notice.hide();
            new Notice(`✅ Import complete: ${path.basename(outputDir)}`);
            this._refreshVault(outputDir);
          },
          onError: (err) => {
            notice.hide();
            new Notice(`❌ EPUB Converter error: ${err}`, 10000);
          },
        }
      );
    } catch (e) {
      notice.hide();
      new Notice(`❌ EPUB Converter: ${(e as Error).message}`, 10000);
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
        .onClick(() => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".epub";
          input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            this.close();
            await this.plugin.convertEpub((file as any).path ?? (file as any).webkitRelativePath ?? "");
          };
          input.click();
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

    // ── Installation ────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "markitdown binary" });

    const statusEl = containerEl.createEl("p", { text: "Checking…" });

    const pluginDir = this.pluginDir();
    checkBinaryInstalled(pluginDir).then(({ installed, version }) => {
      statusEl.setText(
        installed
          ? `✅ markitdown ready${version ? " (" + version + ")" : ""}`
          : "⏳ markitdown not yet downloaded — it will download automatically on first launch, or click Download below."
      );
    });

    new Setting(containerEl)
      .setName("Download / update markitdown")
      .setDesc(
        "Downloads the pre-built markitdown binary from the latest GitHub release. No Python required."
      )
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
              });
              notice.hide();
              new Notice("✅ markitdown ready");
              const { installed, version } = await checkBinaryInstalled(pluginDir);
              statusEl.setText(
                installed
                  ? `✅ markitdown ready${version ? " (" + version + ")" : ""}`
                  : "⚠️ Download failed"
              );
            } catch (e) {
              notice.hide();
              new Notice(`❌ Download failed: ${(e as Error).message}`, 10000);
            }
            btn.setDisabled(false);
            btn.setButtonText("Download");
          })
      );

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

    new Setting(containerEl)
      .setName("Save images")
      .setDesc("Extract and save embedded images to an assets/ subfolder.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.saveImages).onChange(async (value) => {
          this.plugin.settings.saveImages = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Organize chapters")
      .setDesc(
        "Sort chapters into front-matter/, chapters/, back-matter/ subdirectories."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.organize).onChange(async (value) => {
          this.plugin.settings.organize = value;
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
  }

  private pluginDir(): string {
    const vaultRoot = (this.app.vault.adapter as any).getBasePath?.() ?? "";
    return path.join(vaultRoot, ".obsidian", "plugins", "epub-converter");
  }
}
