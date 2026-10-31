import { saveCliproxyConfig } from "./config.ts";

/** Global Fast preference plus the capability set advertised by CLIProxyAPI. */
export class FastModeController {
  private supportedModelIds = new Set<string>();
  private enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setSupportedModelIds(modelIds: Iterable<string>): void {
    this.supportedModelIds = new Set(
      [...modelIds].flatMap((id) => {
        const trimmed = id.trim();

        return trimmed ? [trimmed] : [];
      })
    );
  }

  isEnabled = (): boolean => this.enabled;

  isModelSupported(modelId: string): boolean {
    return this.supportedModelIds.has(modelId.trim());
  }

  isEffectiveFor(modelId: string): boolean {
    return this.enabled && this.isModelSupported(modelId);
  }
}

export interface ToggleFastModeOptions {
  agentDir: string;
  fast: FastModeController;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
  refresh: () => Promise<void>;
}

/** Toggle request behavior immediately, then refresh Fast pricing in place. */
export const toggleFastMode = async (
  options: ToggleFastModeOptions
): Promise<boolean | undefined> => {
  const previous = options.fast.isEnabled();
  const enabled = !previous;
  options.fast.setEnabled(enabled);

  try {
    saveCliproxyConfig(options.agentDir, { fast: enabled });
    await options.refresh();
  } catch (error) {
    options.fast.setEnabled(previous);
    saveCliproxyConfig(options.agentDir, { fast: previous });

    try {
      await options.refresh();
    } catch {
      // The original refresh error is more useful than a secondary rollback error.
    }

    options.notify(
      `Failed to refresh Fast pricing: ${error instanceof Error ? error.message : String(error)}`,
      "warning"
    );

    return undefined;
  }

  options.notify(
    enabled
      ? "Fast mode is enabled globally."
      : "Fast mode is disabled globally.",
    "info"
  );

  return enabled;
};
