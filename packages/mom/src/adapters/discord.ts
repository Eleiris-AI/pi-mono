/**
 * Discord adapter for mom.
 *
 * Uses discord.js v14 with Gateway Intents for message reception.
 * Supports @mentions in channels and DMs, threads for tool results,
 * embeds for rich formatting, and slash commands for stop/memory.
 *
 * Message format: Discord Markdown (close to standard, minor differences).
 *
 * References:
 * - PR #188 (badlogic/pi-mono) for initial Discord exploration
 * - docs/new.md for PlatformAdapter design
 */

import {
	Client,
	type ClientOptions,
	EmbedBuilder,
	Events,
	GatewayIntentBits,
	type Guild,
	type Message,
	Partials,
	type TextChannel,
	type ThreadChannel,
} from "discord.js";
import * as log from "../log.js";
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

export interface DiscordAdapterConfig {
	type: "discord";
	/** Discord bot token */
	botToken: string;
	/** Guild (server) IDs to listen to. Empty = all guilds the bot is in. */
	guildIds?: string[];
	/** Whether to respond to DMs (default: true) */
	allowDMs?: boolean;
}

// Discord message limit is 2000 chars
const DISCORD_MAX_LENGTH = 1900;
const EMBED_DESC_MAX = 4000;

// =============================================================================
// Per-channel run state
// =============================================================================

interface ChannelRunState {
	/** The main response message (editable) */
	message: Message | null;
	/** Thread created for tool details */
	thread: ThreadChannel | null;
	/** Accumulated text */
	accumulatedText: string;
	/** Working indicator active */
	isWorking: boolean;
	/** Serialized update queue */
	updatePromise: Promise<void>;
}

// =============================================================================
// DiscordAdapter
// =============================================================================

export class DiscordAdapter implements PlatformAdapter {
	readonly name = "discord";

	private config: DiscordAdapterConfig;
	private client: Client | null = null;
	private onMessage: OnMessageCallback | null = null;
	private onStop: OnStopCallback | null = null;
	private botUserId: string | null = null;

	/** Cached guild members and channels */
	private users = new Map<string, UserInfo>();
	private channelCache = new Map<string, ChannelInfo>();

	/** Per-channel run state */
	private runStates = new Map<string, ChannelRunState>();

	constructor(config: DiscordAdapterConfig) {
		this.config = config;
	}

	// =========================================================================
	// PlatformAdapter implementation
	// =========================================================================

	async start(onMessage: OnMessageCallback, onStop: OnStopCallback): Promise<void> {
		this.onMessage = onMessage;
		this.onStop = onStop;

		const clientOptions: ClientOptions = {
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.GuildMembers,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.DirectMessages,
			],
			partials: [Partials.Channel], // Required for DM support
		};

		this.client = new Client(clientOptions);

		this.client.once(Events.ClientReady, (readyClient) => {
			this.botUserId = readyClient.user.id;
			log.logInfo(`[discord] Connected as ${readyClient.user.tag}`);

			// Cache guild info
			for (const guild of readyClient.guilds.cache.values()) {
				this.cacheGuild(guild);
			}
		});

		this.client.on(Events.MessageCreate, async (message) => {
			await this.handleMessage(message);
		});

		await this.client.login(this.config.botToken);
	}

	async stop(): Promise<void> {
		if (this.client) {
			this.client.destroy();
			this.client = null;
		}
		log.logInfo("[discord] Disconnected");
	}

	getChannels(): ChannelInfo[] {
		return Array.from(this.channelCache.values());
	}

	getUsers(): UserInfo[] {
		return Array.from(this.users.values());
	}

	resetRunState(channelId: string): void {
		this.runStates.set(channelId, {
			message: null,
			thread: null,
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

				const displayText = state.isWorking ? `${state.accumulatedText}\n\n*⏳ working...*` : state.accumulatedText;

				if (state.message) {
					await this.editDiscordMessage(state.message, displayText);
				} else {
					const channel = await this.getChannel(channelId);
					if (channel) {
						state.message = await this.sendDiscordMessage(channel, displayText);
					}
				}
			} catch (err) {
				log.logWarning("[discord] respond error", err instanceof Error ? err.message : String(err));
			}
		});
		await state.updatePromise;
	}

	async replaceMessage(channelId: string, text: string): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			try {
				state.accumulatedText = text;
				const displayText = state.isWorking ? `${text}\n\n*⏳ working...*` : text;

				if (state.message) {
					await this.editDiscordMessage(state.message, displayText);
				} else {
					const channel = await this.getChannel(channelId);
					if (channel) {
						state.message = await this.sendDiscordMessage(channel, displayText);
					}
				}
			} catch (err) {
				log.logWarning("[discord] replaceMessage error", err instanceof Error ? err.message : String(err));
			}
		});
		await state.updatePromise;
	}

	async respondInThread(channelId: string, text: string): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			try {
				// Create thread on the main message if we don't have one yet
				if (!state.thread && state.message) {
					state.thread = await state.message.startThread({
						name: "Details",
					});
				}

				if (state.thread) {
					// Use embeds for tool results (cleaner than raw text)
					const embed = new EmbedBuilder().setDescription(text.substring(0, EMBED_DESC_MAX)).setColor(0x5865f2); // Discord blurple

					await state.thread.send({ embeds: [embed] });
				}
			} catch (err) {
				log.logWarning("[discord] respondInThread error", err instanceof Error ? err.message : String(err));
			}
		});
		await state.updatePromise;
	}

	async setTyping(channelId: string, _isTyping: boolean): Promise<void> {
		try {
			const channel = await this.getChannel(channelId);
			if (channel && "sendTyping" in channel) {
				await (channel as TextChannel).sendTyping();
			}
		} catch {
			// Best-effort
		}
	}

	async setWorking(channelId: string, working: boolean): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			try {
				state.isWorking = working;
				if (state.message && state.accumulatedText) {
					const displayText = working ? `${state.accumulatedText}\n\n*⏳ working...*` : state.accumulatedText;
					await this.editDiscordMessage(state.message, displayText);
				}
			} catch (err) {
				log.logWarning("[discord] setWorking error", err instanceof Error ? err.message : String(err));
			}
		});
		await state.updatePromise;
	}

	async uploadFile(channelId: string, filePath: string, title?: string): Promise<void> {
		try {
			const channel = await this.getChannel(channelId);
			if (channel && "send" in channel) {
				const { basename } = await import("path");
				await (channel as TextChannel).send({
					files: [{ attachment: filePath, name: title || basename(filePath) }],
				});
			}
		} catch (err) {
			log.logWarning("[discord] uploadFile error", err instanceof Error ? err.message : String(err));
		}
	}

	async deleteMessage(channelId: string): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			try {
				// Delete thread first
				if (state.thread) {
					await state.thread.delete().catch(() => {});
					state.thread = null;
				}
				// Delete main message
				if (state.message) {
					await state.message.delete().catch(() => {});
					state.message = null;
				}
			} catch {
				// Best-effort
			}
		});
		await state.updatePromise;
	}

	logBotResponse(_channelId: string, _text: string, _messageId: string): void {
		// Logging handled by the harness via ChannelStore
	}

	// =========================================================================
	// Message handling
	// =========================================================================

	private async handleMessage(message: Message): Promise<void> {
		// Ignore bot messages
		if (message.author.bot) return;
		if (message.author.id === this.botUserId) return;

		const isDM = !message.guild;
		const isMention = message.mentions.has(this.botUserId || "");

		// In guilds, only respond to @mentions
		// In DMs, respond to everything (if allowed)
		if (!isDM && !isMention) return;
		if (isDM && this.config.allowDMs === false) return;

		// Filter by guild if configured
		if (message.guild && this.config.guildIds?.length && !this.config.guildIds.includes(message.guild.id)) {
			return;
		}

		// Strip bot mention from text
		const text = message.content.replace(new RegExp(`<@!?${this.botUserId}>`, "g"), "").trim();

		if (!text && message.attachments.size === 0) return;

		// Check for stop command
		if (text.toLowerCase() === "stop" && this.onStop) {
			await this.onStop(message.channelId, this);
			return;
		}

		// Cache user info
		this.users.set(message.author.id, {
			id: message.author.id,
			username: message.author.username,
			displayName: message.author.displayName || message.author.username,
		});

		// Normalize to ChannelMessage
		const channelMessage: ChannelMessage = {
			id: message.id,
			channelId: message.channelId,
			timestamp: message.createdAt.toISOString(),
			sender: {
				id: message.author.id,
				username: message.author.username,
				displayName: message.author.displayName || message.author.username,
				isBot: false,
			},
			text,
			attachments: message.attachments.map((a) => ({
				filename: a.name || "unknown",
				localPath: "", // Will be populated by downloadAttachments if needed
				mimeType: a.contentType || undefined,
				size: a.size,
			})),
			isMention: isMention || isDM,
			replyTo: message.reference?.messageId || undefined,
			metadata: {
				guildId: message.guild?.id,
				guildName: message.guild?.name,
				discordChannelName: (message.channel as TextChannel).name || "DM",
			},
		};

		if (this.onMessage) {
			await this.onMessage(channelMessage, this);
		}
	}

	// =========================================================================
	// Discord-specific helpers
	// =========================================================================

	private async getChannel(channelId: string): Promise<TextChannel | null> {
		if (!this.client) return null;
		try {
			const channel = await this.client.channels.fetch(channelId);
			return channel as TextChannel;
		} catch {
			return null;
		}
	}

	/**
	 * Send a message, splitting if it exceeds Discord's 2000 char limit.
	 */
	private async sendDiscordMessage(channel: TextChannel, text: string): Promise<Message | null> {
		const chunks = this.splitMessage(text);
		let lastMessage: Message | null = null;

		for (const chunk of chunks) {
			lastMessage = await channel.send(chunk);
		}

		return lastMessage;
	}

	/**
	 * Edit a message. If the new text is too long, truncate with a note.
	 */
	private async editDiscordMessage(message: Message, text: string): Promise<void> {
		if (text.length > DISCORD_MAX_LENGTH) {
			const truncated = `${text.substring(0, DISCORD_MAX_LENGTH - 50)}\n\n*(see thread for full response)*`;
			await message.edit(truncated);
		} else {
			await message.edit(text);
		}
	}

	private splitMessage(text: string): string[] {
		if (text.length <= DISCORD_MAX_LENGTH) return [text];

		const parts: string[] = [];
		let remaining = text;

		while (remaining.length > 0) {
			if (remaining.length <= DISCORD_MAX_LENGTH) {
				parts.push(remaining);
				break;
			}
			let split = remaining.lastIndexOf("\n", DISCORD_MAX_LENGTH);
			if (split < DISCORD_MAX_LENGTH / 2) split = DISCORD_MAX_LENGTH;
			parts.push(remaining.slice(0, split));
			remaining = remaining.slice(split).trimStart();
		}

		return parts;
	}

	private cacheGuild(guild: Guild): void {
		// Cache text channels
		for (const channel of guild.channels.cache.values()) {
			if (channel.isTextBased() && !channel.isThread()) {
				this.channelCache.set(channel.id, {
					id: channel.id,
					name: `${guild.name}/#${channel.name}`,
					type: "channel",
				});
			}
		}

		// Cache members
		for (const member of guild.members.cache.values()) {
			if (!member.user.bot) {
				this.users.set(member.id, {
					id: member.id,
					username: member.user.username,
					displayName: member.displayName,
				});
			}
		}
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	private getRunState(channelId: string): ChannelRunState {
		let state = this.runStates.get(channelId);
		if (!state) {
			state = {
				message: null,
				thread: null,
				accumulatedText: "",
				isWorking: false,
				updatePromise: Promise.resolve(),
			};
			this.runStates.set(channelId, state);
		}
		return state;
	}
}
