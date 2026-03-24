/**
 * Telegram adapter for mom.
 *
 * Uses the Telegram Bot API with long-polling to receive messages.
 * Converts standard markdown to Telegram MarkdownV2 for responses.
 *
 * Features:
 * - Long-polling (no webhook server needed)
 * - MarkdownV2 formatting with plain-text fallback
 * - Reply tracking for conversation continuity
 * - Message chunking for Telegram's 4096 char limit
 * - Session hints in outgoing messages
 */

import * as log from "../log.js";
import type {
	ChannelInfo,
	ChannelMessage,
	OnMessageCallback,
	OnStopCallback,
	PlatformAdapter,
	RespondOptions,
	UserInfo,
} from "./types.js";

// =============================================================================
// Configuration
// =============================================================================

export interface TelegramAdapterConfig {
	type: "telegram";
	/** Bot token from @BotFather */
	botToken: string;
	/** Chat ID to listen to (single user or group) */
	chatId: number;
	/** Poll timeout in seconds (default: 30) */
	pollTimeout?: number;
}

const TG_MAX_MESSAGE_LENGTH = 4000; // 4096 limit, leave room for formatting
const TG_API_BASE = "https://api.telegram.org/bot";

// =============================================================================
// Markdown → Telegram MarkdownV2 converter
// =============================================================================

/**
 * Escape special characters for Telegram MarkdownV2.
 */
function escapeMarkdownV2(text: string): string {
	return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Convert standard markdown (LLM output) to Telegram MarkdownV2.
 * Falls through to plain text on any error.
 */
function markdownToTelegramV2(text: string): { text: string; parseMode: "MarkdownV2" | undefined } {
	try {
		let result = text;

		// Preserve code blocks first (they don't need internal escaping)
		const codeBlocks: string[] = [];
		result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
			const idx = codeBlocks.length;
			codeBlocks.push(`\`\`\`${lang}\n${code}\`\`\``);
			return `\x00CODEBLOCK${idx}\x00`;
		});

		// Preserve inline code
		const inlineCode: string[] = [];
		result = result.replace(/`([^`]+)`/g, (_match, code) => {
			const idx = inlineCode.length;
			inlineCode.push(`\`${code}\``);
			return `\x00INLINE${idx}\x00`;
		});

		// Bold: **text** → *text*  (MarkdownV2 uses single *)
		result = result.replace(/\*\*(.+?)\*\*/g, (_match, content) => {
			return `*${escapeMarkdownV2(content)}*`;
		});

		// Italic: _text_ → _text_  (same in MarkdownV2, but needs escaping inside)
		// Skip if already handled by bold
		result = result.replace(/(?<!\*)\b_(.+?)_\b(?!\*)/g, (_match, content) => {
			return `_${escapeMarkdownV2(content)}_`;
		});

		// Links: [text](url) → [text](url)  (same format, but text needs escaping)
		result = result.replace(/\[(.+?)\]\((.+?)\)/g, (_match, linkText, url) => {
			return `[${escapeMarkdownV2(linkText)}](${url.replace(/\)/g, "\\)")})`;
		});

		// Escape remaining plain text (not inside formatting markers)
		// This is a simplified approach — escape everything not already handled
		const parts = result.split(/(\x00(?:CODEBLOCK|INLINE)\d+\x00|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/);
		result = parts
			.map((part) => {
				if (
					part.startsWith("\x00") ||
					(part.startsWith("*") && part.endsWith("*")) ||
					(part.startsWith("_") && part.endsWith("_")) ||
					(part.startsWith("[") && part.includes("]("))
				) {
					return part;
				}
				return escapeMarkdownV2(part);
			})
			.join("");

		// Restore code blocks and inline code
		for (let i = 0; i < codeBlocks.length; i++) {
			result = result.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i]);
		}
		for (let i = 0; i < inlineCode.length; i++) {
			result = result.replace(`\x00INLINE${i}\x00`, inlineCode[i]);
		}

		return { text: result, parseMode: "MarkdownV2" };
	} catch {
		// Fall through to plain text on any conversion error
		return { text, parseMode: undefined };
	}
}

// =============================================================================
// TelegramAdapter
// =============================================================================

/**
 * Per-channel run state — tracks the current response message being built.
 */
interface ChannelRunState {
	/** Telegram message_id of the current main response */
	messageId: number | null;
	/** Accumulated text for the current response */
	accumulatedText: string;
	/** Thread messages (tool results, usage) */
	threadMessageIds: number[];
	/** Whether the agent is currently working */
	isWorking: boolean;
	/** Serialized update queue */
	updatePromise: Promise<void>;
}

export class TelegramAdapter implements PlatformAdapter {
	readonly name = "telegram";

	private config: TelegramAdapterConfig;
	private apiBase: string;
	private offset?: number;
	private running = false;
	private onMessage: OnMessageCallback | null = null;
	private onStop: OnStopCallback | null = null;

	/** Per-channel run state */
	private runStates = new Map<string, ChannelRunState>();

	/** Reply tracking: telegramMessageId → channelId (for conversation routing) */
	private replyMap = new Map<number, { channelId: string; timestamp: number }>();
	private readonly REPLY_MAP_TTL_MS = 24 * 60 * 60 * 1000;

	constructor(config: TelegramAdapterConfig) {
		this.config = config;
		this.apiBase = `${TG_API_BASE}${config.botToken}`;
	}

	// =========================================================================
	// PlatformAdapter implementation
	// =========================================================================

	async start(onMessage: OnMessageCallback, onStop: OnStopCallback): Promise<void> {
		this.onMessage = onMessage;
		this.onStop = onStop;
		this.running = true;

		// Initialize offset to skip old messages
		await this.initOffset();
		log.logInfo("[telegram] Connected, starting long-poll loop");

		// Start polling loop (non-blocking)
		this.pollLoop();
	}

	async stop(): Promise<void> {
		this.running = false;
		log.logInfo("[telegram] Stopped");
	}

	getChannels(): ChannelInfo[] {
		// Telegram doesn't have a channel list like Slack
		// Return the configured chat as the only "channel"
		return [
			{
				id: String(this.config.chatId),
				name: "telegram",
				type: "dm" as const,
			},
		];
	}

	getUsers(): UserInfo[] {
		// Telegram doesn't expose a user directory
		return [];
	}

	resetRunState(channelId: string): void {
		this.runStates.set(channelId, {
			messageId: null,
			accumulatedText: "",
			threadMessageIds: [],
			isWorking: false,
			updatePromise: Promise.resolve(),
		});
	}

	async respond(channelId: string, text: string, _options?: RespondOptions): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			try {
				state.accumulatedText = state.accumulatedText ? `${state.accumulatedText}\n${text}` : text;

				const displayText = state.isWorking ? `${state.accumulatedText}\n\n_⏳ working..._` : state.accumulatedText;

				if (state.messageId) {
					await this.editMessage(channelId, state.messageId, displayText);
				} else {
					state.messageId = await this.sendMessage(channelId, displayText);
				}
			} catch (err) {
				log.logWarning("[telegram] respond error", err instanceof Error ? err.message : String(err));
			}
		});
		await state.updatePromise;
	}

	async replaceMessage(channelId: string, text: string): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			try {
				state.accumulatedText = text;
				const displayText = state.isWorking ? `${text}\n\n_⏳ working..._` : text;

				if (state.messageId) {
					await this.editMessage(channelId, state.messageId, displayText);
				} else {
					state.messageId = await this.sendMessage(channelId, displayText);
				}
			} catch (err) {
				log.logWarning("[telegram] replaceMessage error", err instanceof Error ? err.message : String(err));
			}
		});
		await state.updatePromise;
	}

	async respondInThread(channelId: string, text: string): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			try {
				if (state.messageId) {
					// Reply to the main message (Telegram's threading model)
					const msgId = await this.sendMessage(channelId, text, state.messageId);
					if (msgId) state.threadMessageIds.push(msgId);
				}
			} catch (err) {
				log.logWarning("[telegram] respondInThread error", err instanceof Error ? err.message : String(err));
			}
		});
		await state.updatePromise;
	}

	async setTyping(_channelId: string, _isTyping: boolean): Promise<void> {
		try {
			await this.api("sendChatAction", {
				chat_id: this.config.chatId,
				action: "typing",
			});
		} catch {
			// Best-effort
		}
	}

	async setWorking(channelId: string, working: boolean): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			try {
				state.isWorking = working;
				if (state.messageId && state.accumulatedText) {
					const displayText = working ? `${state.accumulatedText}\n\n_⏳ working..._` : state.accumulatedText;
					await this.editMessage(channelId, state.messageId, displayText);
				}
			} catch (err) {
				log.logWarning("[telegram] setWorking error", err instanceof Error ? err.message : String(err));
			}
		});
		await state.updatePromise;
	}

	async uploadFile(_channelId: string, filePath: string, title?: string): Promise<void> {
		try {
			const { readFile } = await import("fs/promises");
			const { basename } = await import("path");
			const fileData = await readFile(filePath);
			const filename = title || basename(filePath);

			const formData = new FormData();
			formData.append("chat_id", String(this.config.chatId));
			formData.append("document", new Blob([fileData]), filename);
			if (title) formData.append("caption", title);

			await fetch(`${this.apiBase}/sendDocument`, {
				method: "POST",
				body: formData,
			});
		} catch (err) {
			log.logWarning("[telegram] uploadFile error", err instanceof Error ? err.message : String(err));
		}
	}

	async deleteMessage(channelId: string): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			try {
				// Delete thread messages first
				for (const msgId of state.threadMessageIds.reverse()) {
					await this.api("deleteMessage", {
						chat_id: this.config.chatId,
						message_id: msgId,
					}).catch(() => {});
				}
				state.threadMessageIds = [];

				// Delete main message
				if (state.messageId) {
					await this.api("deleteMessage", {
						chat_id: this.config.chatId,
						message_id: state.messageId,
					}).catch(() => {});
					state.messageId = null;
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

	formatMarkdown(text: string): string {
		// The adapter handles MarkdownV2 conversion internally in sendMessage/editMessage
		return text;
	}

	// =========================================================================
	// Telegram API
	// =========================================================================

	private async api(method: string, params: Record<string, unknown>): Promise<unknown> {
		const res = await fetch(`${this.apiBase}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(params),
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`Telegram API ${method} failed (${res.status}): ${body}`);
		}

		const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
		if (!json.ok) {
			throw new Error(`Telegram API ${method}: ${json.description || "unknown error"}`);
		}

		return json.result;
	}

	private async initOffset(): Promise<void> {
		try {
			const updates = (await this.api("getUpdates", { timeout: 0 })) as Array<{ update_id: number }>;
			if (updates?.length > 0) {
				this.offset = Math.max(...updates.map((u) => u.update_id)) + 1;
			}
		} catch (err) {
			log.logWarning("[telegram] initOffset error", err instanceof Error ? err.message : String(err));
		}
	}

	private async pollLoop(): Promise<void> {
		while (this.running) {
			try {
				const params: Record<string, unknown> = {
					timeout: this.config.pollTimeout ?? 30,
					allowed_updates: ["message"],
				};
				if (this.offset !== undefined) params.offset = this.offset;

				const updates = (await this.api("getUpdates", params)) as Array<{
					update_id: number;
					message?: {
						message_id: number;
						from?: { id: number; username?: string; first_name?: string };
						chat: { id: number };
						text?: string;
						reply_to_message?: { message_id: number };
						document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
						photo?: Array<{ file_id: string; file_size?: number }>;
					};
				}>;

				if (!updates?.length) continue;

				for (const update of updates) {
					this.offset = update.update_id + 1;

					const msg = update.message;
					if (!msg?.text || msg.chat.id !== this.config.chatId) continue;

					// Check for stop command
					if (msg.text.toLowerCase().trim() === "stop") {
						if (this.onStop) {
							await this.onStop(String(this.config.chatId), this);
						}
						continue;
					}

					// Normalize to ChannelMessage
					const channelMessage: ChannelMessage = {
						id: String(msg.message_id),
						channelId: String(this.config.chatId),
						timestamp: new Date().toISOString(),
						sender: {
							id: String(msg.from?.id || "unknown"),
							username: msg.from?.username || msg.from?.first_name || "user",
							displayName: msg.from?.first_name,
							isBot: false,
						},
						text: msg.text,
						attachments: [],
						isMention: true, // In DM, every message is a mention
						replyTo: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
					};

					if (this.onMessage) {
						await this.onMessage(channelMessage, this);
					}
				}
			} catch (err) {
				log.logWarning("[telegram] poll error", err instanceof Error ? err.message : String(err));
				// Back off on error
				await new Promise((r) => setTimeout(r, 5000));
			}
		}
	}

	// =========================================================================
	// Message sending (with MarkdownV2 + fallback + chunking)
	// =========================================================================

	/**
	 * Send a message to a channel. Returns the message_id.
	 */
	private async sendMessage(channelId: string, text: string, replyToMessageId?: number): Promise<number | null> {
		if (!text?.trim()) return null;

		// Chunk if needed
		const chunks = this.splitMessage(text);
		let lastMessageId: number | null = null;

		for (const chunk of chunks) {
			lastMessageId = await this.sendChunk(chunk, replyToMessageId);
		}

		// Track for reply routing
		if (lastMessageId) {
			this.replyMap.set(lastMessageId, {
				channelId,
				timestamp: Date.now(),
			});
			this.pruneReplyMap();
		}

		return lastMessageId;
	}

	private async sendChunk(text: string, replyToMessageId?: number): Promise<number | null> {
		const params: Record<string, unknown> = {
			chat_id: this.config.chatId,
		};
		if (replyToMessageId) {
			params.reply_to_message_id = replyToMessageId;
		}

		// Try MarkdownV2 first
		const { text: mdText, parseMode } = markdownToTelegramV2(text);
		if (parseMode) {
			try {
				params.text = mdText;
				params.parse_mode = "MarkdownV2";
				const result = (await this.api("sendMessage", params)) as { message_id: number };
				return result?.message_id ?? null;
			} catch {
				// Fall through to plain text
				delete params.parse_mode;
			}
		}

		// Plain text fallback
		params.text = text;
		const result = (await this.api("sendMessage", params)) as { message_id: number };
		return result?.message_id ?? null;
	}

	private async editMessage(_channelId: string, messageId: number, text: string): Promise<void> {
		const params: Record<string, unknown> = {
			chat_id: this.config.chatId,
			message_id: messageId,
		};

		// Try MarkdownV2 first
		const { text: mdText, parseMode } = markdownToTelegramV2(text);
		if (parseMode) {
			try {
				params.text = mdText;
				params.parse_mode = "MarkdownV2";
				await this.api("editMessageText", params);
				return;
			} catch {
				delete params.parse_mode;
			}
		}

		// Plain text fallback
		params.text = text;
		await this.api("editMessageText", params);
	}

	private splitMessage(text: string): string[] {
		if (text.length <= TG_MAX_MESSAGE_LENGTH) return [text];

		const parts: string[] = [];
		let remaining = text;

		while (remaining.length > 0) {
			if (remaining.length <= TG_MAX_MESSAGE_LENGTH) {
				parts.push(remaining);
				break;
			}
			let split = remaining.lastIndexOf("\n", TG_MAX_MESSAGE_LENGTH);
			if (split < TG_MAX_MESSAGE_LENGTH / 2) split = TG_MAX_MESSAGE_LENGTH;
			parts.push(remaining.slice(0, split));
			remaining = remaining.slice(split).trimStart();
		}

		return parts;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	private getRunState(channelId: string): ChannelRunState {
		let state = this.runStates.get(channelId);
		if (!state) {
			state = {
				messageId: null,
				accumulatedText: "",
				threadMessageIds: [],
				isWorking: false,
				updatePromise: Promise.resolve(),
			};
			this.runStates.set(channelId, state);
		}
		return state;
	}

	private pruneReplyMap(): void {
		const now = Date.now();
		for (const [id, entry] of this.replyMap) {
			if (now - entry.timestamp > this.REPLY_MAP_TTL_MS) {
				this.replyMap.delete(id);
			}
		}
	}
}
