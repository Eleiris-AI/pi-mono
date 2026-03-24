/**
 * Slack adapter for mom.
 *
 * Wraps the existing SlackBot class to implement PlatformAdapter.
 * This is a thin adapter layer — all Slack-specific logic remains in slack.ts.
 *
 * The SlackBot owns its own event loop (Socket Mode), message sending,
 * backfill, user/channel caching, and per-channel queuing. This adapter
 * bridges that to the platform-agnostic PlatformAdapter interface.
 */

import { type MomHandler, type SlackBot, SlackBot as SlackBotClass, type SlackEvent } from "../slack.js";
import { ChannelStore } from "../store.js";
import type {
	ChannelInfo,
	ChannelMessage,
	OnMessageCallback,
	OnStopCallback,
	PlatformAdapter,
	UserInfo,
} from "./types.js";

// =============================================================================
// Configuration
// =============================================================================

export interface SlackAdapterConfig {
	type: "slack";
	/** Slack app-level token (xapp-...) for Socket Mode */
	appToken: string;
	/** Slack bot token (xoxb-...) for Web API */
	botToken: string;
	/** Working directory for channel data */
	workingDir: string;
}

// =============================================================================
// Per-channel run state
// =============================================================================

interface ChannelRunState {
	/** Slack timestamp of the current main response message */
	messageTs: string | null;
	/** Timestamps of thread messages (tool results, usage) */
	threadMessageTs: string[];
	/** Accumulated text for the current response */
	accumulatedText: string;
	/** Whether the agent is currently working */
	isWorking: boolean;
	/** Serialized update queue */
	updatePromise: Promise<void>;
}

// Slack mrkdwn message limit (40K, use 35K for safety)
const MAX_MAIN_LENGTH = 35000;
const MAX_THREAD_LENGTH = 20000;
const TRUNCATION_NOTE = "\n\n_(message truncated, ask me to elaborate on specific parts)_";
const WORKING_INDICATOR = " ...";

// =============================================================================
// SlackAdapter
// =============================================================================

export class SlackAdapter implements PlatformAdapter {
	readonly name = "slack";

	private config: SlackAdapterConfig;
	private bot: SlackBot | null = null;
	private store: ChannelStore;

	/** Per-channel run state for response rendering */
	private runStates = new Map<string, ChannelRunState>();

	constructor(config: SlackAdapterConfig) {
		this.config = config;
		this.store = new ChannelStore({
			workingDir: config.workingDir,
			botToken: config.botToken,
		});
	}

	// =========================================================================
	// PlatformAdapter implementation
	// =========================================================================

	async start(onMessage: OnMessageCallback, onStop: OnStopCallback): Promise<void> {
		// Create the MomHandler bridge that routes SlackBot events to PlatformAdapter callbacks
		const handler = this.createHandler(onMessage, onStop);

		// Create and start the SlackBot (owns Socket Mode connection + event loop)
		this.bot = new SlackBotClass(handler, {
			appToken: this.config.appToken,
			botToken: this.config.botToken,
			workingDir: this.config.workingDir,
			store: this.store,
		});

		await this.bot.start();
	}

	async stop(): Promise<void> {
		// SlackBot doesn't expose a stop() method — it runs until process exit
		this.bot = null;
	}

	getChannels(): ChannelInfo[] {
		if (!this.bot) return [];
		return this.bot.getAllChannels().map((c) => ({
			id: c.id,
			name: c.name,
			type: (c.name.startsWith("DM:") ? "dm" : "channel") as "dm" | "channel",
		}));
	}

	getUsers(): UserInfo[] {
		if (!this.bot) return [];
		return this.bot.getAllUsers().map((u) => ({
			id: u.id,
			username: u.userName,
			displayName: u.displayName,
		}));
	}

	resetRunState(channelId: string): void {
		this.runStates.set(channelId, {
			messageTs: null,
			threadMessageTs: [],
			accumulatedText: "",
			isWorking: false,
			updatePromise: Promise.resolve(),
		});
	}

	async respond(channelId: string, text: string): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			try {
				state.accumulatedText = state.accumulatedText ? `${state.accumulatedText}\n${text}` : text;

				// Truncate if too long
				if (state.accumulatedText.length > MAX_MAIN_LENGTH) {
					state.accumulatedText =
						state.accumulatedText.substring(0, MAX_MAIN_LENGTH - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
				}

				const displayText = state.isWorking ? state.accumulatedText + WORKING_INDICATOR : state.accumulatedText;

				if (state.messageTs && this.bot) {
					await this.bot.updateMessage(channelId, state.messageTs, displayText);
				} else if (this.bot) {
					state.messageTs = await this.bot.postMessage(channelId, displayText);
				}

				// Log the response
				if (state.messageTs) {
					this.bot?.logBotResponse(channelId, text, state.messageTs);
				}
			} catch {
				// Swallow Slack API errors to not break the agent flow
			}
		});
		await state.updatePromise;
	}

	async replaceMessage(channelId: string, text: string): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			try {
				// Truncate if needed
				if (text.length > MAX_MAIN_LENGTH) {
					state.accumulatedText = text.substring(0, MAX_MAIN_LENGTH - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
				} else {
					state.accumulatedText = text;
				}

				const displayText = state.isWorking ? state.accumulatedText + WORKING_INDICATOR : state.accumulatedText;

				if (state.messageTs && this.bot) {
					await this.bot.updateMessage(channelId, state.messageTs, displayText);
				} else if (this.bot) {
					state.messageTs = await this.bot.postMessage(channelId, displayText);
				}
			} catch {
				// Swallow
			}
		});
		await state.updatePromise;
	}

	async respondInThread(channelId: string, text: string): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			try {
				if (state.messageTs && this.bot) {
					let threadText = text;
					if (threadText.length > MAX_THREAD_LENGTH) {
						threadText = `${threadText.substring(0, MAX_THREAD_LENGTH - 50)}\n\n_(truncated)_`;
					}
					const ts = await this.bot.postInThread(channelId, state.messageTs, threadText);
					state.threadMessageTs.push(ts);
				}
			} catch {
				// Swallow
			}
		});
		await state.updatePromise;
	}

	async setTyping(channelId: string, _isTyping: boolean): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			try {
				if (!state.messageTs && this.bot) {
					state.accumulatedText = "_Thinking_";
					state.messageTs = await this.bot.postMessage(channelId, state.accumulatedText + WORKING_INDICATOR);
				}
			} catch {
				// Swallow
			}
		});
		await state.updatePromise;
	}

	async setWorking(channelId: string, working: boolean): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			try {
				state.isWorking = working;
				if (state.messageTs && this.bot) {
					const displayText = working ? state.accumulatedText + WORKING_INDICATOR : state.accumulatedText;
					await this.bot.updateMessage(channelId, state.messageTs, displayText);
				}
			} catch {
				// Swallow
			}
		});
		await state.updatePromise;
	}

	async uploadFile(channelId: string, filePath: string, title?: string): Promise<void> {
		if (this.bot) {
			await this.bot.uploadFile(channelId, filePath, title);
		}
	}

	async deleteMessage(channelId: string): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			if (!this.bot) return;
			try {
				// Delete thread messages first (reverse order)
				for (let i = state.threadMessageTs.length - 1; i >= 0; i--) {
					await this.bot.deleteMessage(channelId, state.threadMessageTs[i]).catch(() => {});
				}
				state.threadMessageTs = [];

				// Delete main message
				if (state.messageTs) {
					await this.bot.deleteMessage(channelId, state.messageTs);
					state.messageTs = null;
				}
			} catch {
				// Swallow
			}
		});
		await state.updatePromise;
	}

	logBotResponse(channelId: string, text: string, messageId: string): void {
		this.bot?.logBotResponse(channelId, text, messageId);
	}

	// =========================================================================
	// Internal: Bridge SlackBot events → PlatformAdapter callbacks
	// =========================================================================

	/**
	 * Create a MomHandler that bridges SlackBot events to the adapter's callbacks.
	 * This keeps the SlackBot's event loop intact while routing to the new interface.
	 */
	private createHandler(onMessage: OnMessageCallback, onStop: OnStopCallback): MomHandler {
		const runningChannels = new Set<string>();

		return {
			isRunning(channelId: string): boolean {
				return runningChannels.has(channelId);
			},

			handleStop: async (channelId: string, _slack: SlackBot): Promise<void> => {
				await onStop(channelId, this);
			},

			handleEvent: async (event: SlackEvent, _slack: SlackBot, _isEvent?: boolean): Promise<void> => {
				runningChannels.add(event.channel);
				try {
					const channelMessage = this.normalizeSlackEvent(event);
					await onMessage(channelMessage, this);
				} finally {
					runningChannels.delete(event.channel);
				}
			},
		};
	}

	/**
	 * Normalize a SlackEvent to a platform-agnostic ChannelMessage.
	 */
	private normalizeSlackEvent(event: SlackEvent): ChannelMessage {
		const user = this.bot?.getUser(event.user);

		return {
			id: event.ts,
			channelId: event.channel,
			timestamp: new Date(parseFloat(event.ts) * 1000).toISOString(),
			sender: {
				id: event.user,
				username: user?.userName || event.user,
				displayName: user?.displayName,
				isBot: false,
			},
			text: event.text,
			attachments: (event.attachments || []).map((a) => ({
				filename: a.original,
				localPath: a.local,
			})),
			isMention: event.type === "mention" || event.type === "dm",
			metadata: {
				slackTs: event.ts,
				slackEventType: event.type,
			},
		};
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	private getRunState(channelId: string): ChannelRunState {
		let state = this.runStates.get(channelId);
		if (!state) {
			state = {
				messageTs: null,
				threadMessageTs: [],
				accumulatedText: "",
				isWorking: false,
				updatePromise: Promise.resolve(),
			};
			this.runStates.set(channelId, state);
		}
		return state;
	}

	/** Expose the underlying store for the harness */
	getStore(): ChannelStore {
		return this.store;
	}

	/** Expose the underlying SlackBot for events integration */
	getBot(): SlackBot | null {
		return this.bot;
	}
}
