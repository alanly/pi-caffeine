import { describe, expect, it } from "vitest";
import type { CaffeineState } from "../src/types.ts";
import { formatStatus, STATUS_KEY } from "../src/statusline.ts";

function stateWithHolder(): CaffeineState {
	return {
		holder: {
			proc: { pid: 1234 } as never,
			platform: "darwin",
			startedAt: Date.now(),
		},
	};
}

describe("STATUS_KEY", () => {
	it("is namespaced to this extension", () => {
		expect(STATUS_KEY).toBe("caffeine");
	});
});

describe("formatStatus", () => {
	it("returns the coffee symbol when a holder is active", () => {
		expect(formatStatus(stateWithHolder(), "☕")).toBe("☕");
	});

	it("returns a custom symbol when configured", () => {
		expect(formatStatus(stateWithHolder(), "ZZZ")).toBe("ZZZ");
	});

	it("returns undefined when no holder is active", () => {
		expect(formatStatus({ holder: null }, "☕")).toBeUndefined();
	});
});
