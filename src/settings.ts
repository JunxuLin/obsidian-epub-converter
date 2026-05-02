export interface EpubConverterSettings {
  /** Folder inside the vault where books are written, e.g. "Books" */
  outputFolder: string;
  /** Extract and save images into assets/ subfolder */
  saveImages: boolean;
  /** Organize into front-matter/chapters/back-matter subdirs */
  organize: boolean;
  /** What to do when the output folder already exists */
  onConflict: "ask" | "rename" | "overwrite";
}

export const DEFAULT_SETTINGS: EpubConverterSettings = {
  outputFolder: "Books",
  saveImages: true,
  organize: true,
  onConflict: "rename",
};
