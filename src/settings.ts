export interface EpubConverterSettings {
  /** Folder inside the vault where books are written, e.g. "Books" */
  outputFolder: string;
  /** What to do when the output folder already exists */
  onConflict: "ask" | "rename" | "overwrite";
  /** Write activity to a log file in the plugin folder */
  debugLog: boolean;
}

export const DEFAULT_SETTINGS: EpubConverterSettings = {
  outputFolder: "Books",
  onConflict: "rename",
  debugLog: true,
};
