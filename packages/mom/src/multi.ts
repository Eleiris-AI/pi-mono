#!/usr/bin/env node
/**
 * Multi-platform entry point for mom.
 *
 * Reads config.json, starts configured platform adapters, and wires them
 * to the agent core. This is the platform-agnostic alternative to main.ts
 * (which is Slack-only).
 *
 * Usage:
 *   mom-multi [--sandbox=host|docker:<name>] <working-directory>
 *
 * Config file: <working-directory>/config.json
 *
 * Example config.json:
 * {
 *   "adapters": {
 *     "slack-team": {
 *       "type": "slack",
 *       "appToken": "xapp-...",
 *       "botToken": "xoxb-...",
 *       "workingDir": "./data"
 *     },
 *     "telegram-john": {
 *       "type": "telegram",
 *       "botToken": "123:ABC...",
 *       "chatId": 1234567890
 *     },
 *     "discord-server": {
 *       "type": "discord",
 *       "botToken": "...",
 *       "guildIds": ["123456789"],
 *       "allowDMs": true
 *     }
 *   }
 * }
 */

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { type ChannelMessage, createAdapter, type MomConfig, type PlatformAdapter } from "./adapters/index.js";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { ChannelStore } from "./store.js";

// =============================================================================
// CLI argument parsing
// =============================================================================

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
	};
}

// =============================================================================
// Per-channel state
// =============================================================================

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	adapterName: string;
}

// =============================================================================
// Main
// =============================================================================

const parsedArgs = parseArgs();

if (!parsedArgs.workingDir) {
	console.error("Usage: mom-multi [--sandbox=host|docker:<name>] <working-directory>");
	process.exit(1);
}

const { workingDir, sandbox } = { workingDir: parsedArgs.workingDir, sandbox: parsedArgs.sandbox };

await validateSandbox(sandbox);

// Load config
const configPath = join(workingDir, "config.json");
if (!existsSync(configPath)) {
	console.error(`Config file not found: ${configPath}`);
	console.error("Create a config.json with adapter definitions. See docs/new.md for format.");
	process.exit(1);
}

let config: MomConfig;
try {
	config = JSON.parse(readFileSync(configPath, "utf-8")) as MomConfig;
} catch (err) {
	console.error(`Failed to parse config.json: ${err instanceof Error ? err.message : err}`);
	process.exit(1);
}

if (!config.adapters || Object.keys(config.adapters).length === 0) {
	console.error("No adapters configured in config.json");
	process.exit(1);
}

// =============================================================================
// Channel state management
// =============================================================================

const channelStates = new Map<string, ChannelState>();

/**
 * Get or create channel state. Channels are namespaced by adapter name
 * to prevent collisions (e.g., Slack channel "C123" vs Discord channel "C123").
 */
function getState(adapterName: string, channelId: string): ChannelState {
	const key = `${adapterName}/${channelId}`;
	let state = channelStates.get(key);
	if (!state) {
		// Channel directory uses a flat compound ID that mom's agent.ts can parse.
		// agent.ts derives workspacePath via channelDir.replace(`/${runnerId}`, ""),
		// so we must ensure the runnerId matches the last path segment.
		const compoundId = `${adapterName}-${channelId}`;
		const channelDir = join(workingDir, compoundId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, compoundId, channelDir),
			store: new ChannelStore({ workingDir, botToken: "" }),
			stopRequested: false,
			adapterName,
		};
		channelStates.set(key, state);
	}
	return state;
}

// =============================================================================
// Platform-agnostic agent runner bridge
// =============================================================================

/**
 * Handle an incoming message from any platform adapter.
 * Bridges the PlatformAdapter callback to the agent runner.
 */
async function handleMessage(message: ChannelMessage, adapter: PlatformAdapter): Promise<void> {
	const state = getState(adapter.name, message.channelId);

	if (state.running) {
		await adapter.respond(message.channelId, "_Already working. Say `stop` to cancel._");
		return;
	}

	state.running = true;
	state.stopRequested = false;

	log.logInfo(`[${adapter.name}/${message.channelId}] Starting run: ${message.text.substring(0, 50)}`);

	try {
		// Reset adapter's per-run state (accumulated text, message refs, etc.)
		adapter.resetRunState(message.channelId);

		// Build a SlackContext-compatible object for the agent runner.
		// The runner expects this shape — we bridge from our adapter methods.
		const ctx = {
			message: {
				text: message.text,
				rawText: message.rawText || message.text,
				user: message.sender.id,
				userName: message.sender.username,
				channel: message.channelId,
				ts: message.id,
				attachments: message.attachments.map((a) => ({ local: a.localPath })),
			},
			channelName: adapter.getChannels().find((c) => c.id === message.channelId)?.name,
			channels: adapter.getChannels().map((c) => ({ id: c.id, name: c.name })),
			users: adapter
				.getUsers()
				.map((u) => ({ id: u.id, userName: u.username, displayName: u.displayName || u.username })),
			store: state.store,

			respond: async (text: string, shouldLog = true) => {
				await adapter.respond(message.channelId, text, { shouldLog });
			},
			replaceMessage: async (text: string) => {
				await adapter.replaceMessage(message.channelId, text);
			},
			respondInThread: async (text: string) => {
				await adapter.respondInThread(message.channelId, text);
			},
			setTyping: async (isTyping: boolean) => {
				await adapter.setTyping(message.channelId, isTyping);
			},
			uploadFile: async (filePath: string, title?: string) => {
				await adapter.uploadFile(message.channelId, filePath, title);
			},
			setWorking: async (working: boolean) => {
				await adapter.setWorking(message.channelId, working);
			},
			deleteMessage: async () => {
				await adapter.deleteMessage(message.channelId);
			},
		};

		// Run the agent
		await ctx.setTyping(true);
		await ctx.setWorking(true);
		const result = await state.runner.run(ctx as any, state.store);
		await ctx.setWorking(false);

		if (result.stopReason === "aborted" && state.stopRequested) {
			await adapter.respond(message.channelId, "_Stopped_");
		}
	} catch (err) {
		log.logWarning(
			`[${adapter.name}/${message.channelId}] Run error`,
			err instanceof Error ? err.message : String(err),
		);
	} finally {
		state.running = false;
	}
}

/**
 * Handle a stop command from any platform adapter.
 */
async function handleStop(channelId: string, adapter: PlatformAdapter): Promise<void> {
	const key = `${adapter.name}/${channelId}`;
	const state = channelStates.get(key);

	if (state?.running) {
		state.stopRequested = true;
		state.runner.abort();
		await adapter.respond(channelId, "_Stopping..._");
	} else {
		await adapter.respond(channelId, "_Nothing running_");
	}
}

// =============================================================================
// Start adapters
// =============================================================================

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

const adapters: PlatformAdapter[] = [];

for (const [name, adapterConfig] of Object.entries(config.adapters)) {
	try {
		// Inject workingDir for adapters that need it (Slack)
		const configWithDir = { ...adapterConfig, workingDir };
		const adapter = createAdapter(name, configWithDir);
		adapters.push(adapter);
		log.logInfo(`Created adapter: ${name} (${adapterConfig.type})`);
	} catch (err) {
		log.logWarning(`Failed to create adapter ${name}`, err instanceof Error ? err.message : String(err));
	}
}

if (adapters.length === 0) {
	console.error("No adapters could be created. Check config.json.");
	process.exit(1);
}

// Start all adapters
for (const adapter of adapters) {
	try {
		await adapter.start(handleMessage, handleStop);
		log.logInfo(`Started adapter: ${adapter.name}`);
	} catch (err) {
		log.logWarning(`Failed to start adapter ${adapter.name}`, err instanceof Error ? err.message : String(err));
	}
}

log.logInfo(`Multi-platform mom running with ${adapters.length} adapter(s)`);

// =============================================================================
// Shutdown
// =============================================================================

async function cleanup(): Promise<void> {
	log.logInfo("Shutting down...");
	for (const adapter of adapters) {
		try {
			await adapter.stop();
		} catch {
			// Best-effort
		}
	}
	process.exit(0);
}

process.on("SIGINT", () => {
	cleanup();
});
process.on("SIGTERM", () => {
	cleanup();
});
