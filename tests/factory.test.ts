import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const spawnMock = vi.fn(() => {
	// A minimal ChildProcess stand-in: an EventEmitter with pid/kill.
	const proc = new EventEmitter() as EventEmitter & { pid: number; kill: (s?: string) => boolean };
	proc.pid = 5555;
	proc.kill = () => true;
	return proc;
});
vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return { ...original, spawn: spawnMock };
});

// Import after the mock so the hoisted mock factory sees spawnMock.
const { createCaffeineExtension } = await import("../index.ts");

afterEach(() => {
	vi.clearAllMocks();
});

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

function mockPi(settings: unknown = {}) {
	const calls = {
		events: [] as Array<[string, Handler]>,
		commands: [] as Array<{ name: string; handler: Handler }>,
	};
	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			calls.events.push([event, handler]);
		}),
		registerCommand: vi.fn((name: string, cmd: { handler: Handler }) => {
			calls.commands.push({ name, handler: cmd.handler });
		}),
		getSettings: vi.fn(() => settings),
	} as unknown as ExtensionAPI;
	return { pi, calls };
}

function mockCtx() {
	const statuses: Array<[string, string | undefined]> = [];
	const notifications: string[] = [];
	const ctx = {
		ui: {
			setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionContext;
	return { ctx, statuses, notifications };
}

function handlerFor(calls: ReturnType<typeof mockPi>["calls"], event: string): Handler {
	const found = calls.events.find(([name]) => name === event);
	expect(found, `handler for ${event}`).toBeDefined();
	return found![1];
}

describe("factory wiring", () => {
	it("registers agent_start, agent_settled, session_shutdown handlers and /caffeine", () => {
		const { pi, calls } = mockPi();
		createCaffeineExtension(pi);
		expect(calls.events.map(([e]) => e)).toEqual(["agent_start", "agent_settled", "session_shutdown"]);
		expect(calls.commands.map((c) => c.name)).toEqual(["caffeine"]);
		expect(spawnMock).not.toHaveBeenCalled(); // no spawn in the factory
	});

	it("does not call pi.getSettings() during factory load (would throw in real Pi)", () => {
		const { pi } = mockPi();
		createCaffeineExtension(pi);
		expect(pi.getSettings as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("acquires on agent_start and releases on agent_settled", () => {
		const { pi, calls } = mockPi();
		createCaffeineExtension(pi);
		const { ctx, statuses } = mockCtx();
		handlerFor(calls, "agent_start")({}, ctx);
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(statuses).toEqual([["caffeine", "☕"]]);
		handlerFor(calls, "agent_settled")({}, ctx);
		expect(statuses.at(-1)).toEqual(["caffeine", undefined]);
	});

	it("releases on session_shutdown and the release is idempotent", () => {
		const { pi, calls } = mockPi();
		createCaffeineExtension(pi);
		const { ctx, statuses } = mockCtx();
		handlerFor(calls, "agent_start")({}, ctx);
		const shutdown = handlerFor(calls, "session_shutdown");
		shutdown({}, ctx);
		shutdown({}, ctx);
		expect(spawnMock).toHaveBeenCalledTimes(1); // still only one holder ever spawned
		expect(statuses.at(-1)).toEqual(["caffeine", undefined]);
	});

	it("/caffeine notifies the current state without changing it", () => {
		const { pi, calls } = mockPi();
		createCaffeineExtension(pi);
		const { ctx, notifications } = mockCtx();
		const cmd = calls.commands.find((c) => c.name === "caffeine")!;
		cmd.handler("", ctx);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toBe("no wake assertion held");
		expect(spawnMock).not.toHaveBeenCalled();
	});
});
