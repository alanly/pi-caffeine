/**
 * Configuration: the settings.json "caffeine" block. pi.getSettings() returns
 * the global settings merged with the project settings, so one read covers
 * both scopes. pi.getSettings() is not available during extension loading,
 * so the factory reads the config lazily on first use.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CaffeineConfig } from "./types.ts";

export const DEFAULT_MAX_HOLD_MINUTES = 1440; // 24 h
export const DEFAULT_STATUS_SYMBOL = "☕";

export const DEFAULT_CONFIG: CaffeineConfig = {
	enabled: true,
	maxHoldMinutes: DEFAULT_MAX_HOLD_MINUTES,
	statusSymbol: DEFAULT_STATUS_SYMBOL,
};

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** Normalize an untrusted settings block into a valid config. */
export function normalizeConfig(raw: unknown): CaffeineConfig {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
	const value = raw as Partial<Record<keyof CaffeineConfig, unknown>>;
	return {
		enabled: typeof value.enabled === "boolean" ? value.enabled : true,
		maxHoldMinutes: positiveInteger(value.maxHoldMinutes, DEFAULT_MAX_HOLD_MINUTES),
		statusSymbol: nonEmptyString(value.statusSymbol, DEFAULT_STATUS_SYMBOL),
	};
}

/** Read the "caffeine" block from the merged settings. */
export function loadConfig(settings: ReturnType<ExtensionAPI["getSettings"]>): CaffeineConfig {
	return normalizeConfig((settings as Record<string, unknown>).caffeine);
}
