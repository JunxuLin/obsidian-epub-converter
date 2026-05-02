# EPUB Converter — Obsidian Plugin

> Import EPUB books into your vault as organized Markdown folders, powered by [markitdown](https://github.com/JunxuLin/markitdown).

---

## Features

- **One-click import** — drag an EPUB or pick one from the file browser
- **Organized structure** — chapters sorted into `front-matter/`, `chapters/`, `back-matter/`
- **Image extraction** — embedded images saved to `assets/`
- **Cross-chapter links** rewritten to Obsidian-compatible `[[wikilinks]]`
- **Block references** for footnote/citation jumping (`^id`)
- **README.md** generated with book metadata and TOC
- **Isolated install** — markitdown lives in its own venv; your system packages are untouched

---

## Requirements

- **Obsidian** 1.4+, desktop (Electron) only
- **Python 3.10+** on your system PATH (or set a custom path in settings)
- **Internet** for the one-time markitdown install (uses GitHub)

---

## Installation

### From this repository

1. Clone or download this repo.
2. Copy the folder to `<your-vault>/.obsidian/plugins/epub-converter/`.
3. Enable **EPUB Converter** in **Settings → Community plugins**.
4. Open **Settings → EPUB Converter** and click **Install** to install markitdown into the plugin's venv.

### Development build

```bash
git clone https://github.com/JunxuLin/obsidian-epub-converter
cd obsidian-epub-converter
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, and `styles.css` to your vault's plugin folder.

---

## Creating a GitHub release

When publishing a new version, attach these files to the GitHub release:

```
main.js
manifest.json
styles.css
markitdown-macos-arm64        ← from JunxuLin/markitdown releases
markitdown-windows-x64.exe    ← from JunxuLin/markitdown releases
```

The plugin downloads the correct binary for the user's platform automatically on first launch. No Python or other dependencies required.

---

## Usage

### Import an EPUB

**Option A — Ribbon icon**  
Click the 📚 book icon in the left sidebar.

**Option B — Command palette**  
`Ctrl/Cmd + P` → *EPUB Converter: Import EPUB*

**Option C — File context menu**  
Right-click any `.epub` file inside your vault → *Import EPUB with EPUB Converter*

After selecting a file, conversion runs in the background. A notice shows progress, and when done, the book's `README.md` opens automatically.

---

## Output structure

```
Books/
└── My-Book-Title/
    ├── README.md                  ← metadata + TOC
    ├── front-matter/
    │   ├── cover.md
    │   ├── title-page.md
    │   └── introduction.md
    ├── chapters/
    │   ├── 01-the-beginning.md
    │   ├── 02-the-middle.md
    │   └── ...
    ├── back-matter/
    │   ├── references.md
    │   └── index.md
    └── assets/
        └── fig-01.png
```

---

## Settings

| Setting | Default | Description |
|---|---|---|
| Books folder | `Books` | Vault-relative folder where books are saved |
| Save images | ✅ | Extract embedded images |
| Organize chapters | ✅ | Sort into front-matter/chapters/back-matter |
| If folder exists | Rename | Rename / Overwrite / Ask |
| Python path | auto | Custom python3 path (optional) |

---

## How it works

1. The plugin spawns `venv/bin/markitdown` (installed in the plugin folder, not system-wide).
2. markitdown converts the EPUB spine items to Markdown with `--split-by-chapter`.
3. Each spine item is classified by `epub:type` or manifest-ID heuristics and placed in the right subfolder.
4. Cross-chapter links and block references are rewritten for Obsidian compatibility.
5. Obsidian's vault adapter is asked to reconcile the new files.

---

## License

MIT
