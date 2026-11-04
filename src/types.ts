/**
 * Shared types for pi-caffeine.
 */

import type { ChildProcess } from "node:child_process";

/** Operating system families the extension supports. */
export type Platform = "darwin" | "win32" | "linux" | "other";

/** A running holder process that owns the wake assertion. */
export interface HolderHandle {
	proc: ChildProcess;
	platform: Platform;
	startedAt: number;
	/** Set by the exit listener; true once the holder process has exited. */
	exited?: boolean;
}

/** The manager state: at most one holder at a time. */
export interface CaffeineState {
	holder: HolderHandle | null;
}

/** User-configurable settings from the settings.json "caffeine" block. */
export interface CaffeineConfig {
	/** Master switch. false keeps the extension loaded but inert. */
	enabled: boolean;
	/** Maximum hold duration in minutes. Passed to the holder as a hard cap. */
	maxHoldMinutes: number;
	/** Footer symbol shown while the assertion is held. */
	statusSymbol: string;
}

/** A spawnable command: program plus argument list. */
export interface HolderCommand {
	command: string;
	args: string[];
}
