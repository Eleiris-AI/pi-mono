/**
 * WhatsApp adapter for mom.
 *
 * Uses the WhatsApp Cloud API (hosted by Meta) for messaging.
 * Requires a Meta Business account, WhatsApp Business phone number,
 * and a webhook endpoint for receiving messages.
 *
 * Architecture:
 * - Outbound: Direct HTTPS calls to graph.facebook.com
 * - Inbound: Express webhook server that Meta pushes messages to
 *
 * Key constraints:
 * - 24-hour customer service window (free replies after user messages)
 * - Outside the window, only pre-approved template messages allowed
 * - Message limit: 4096 characters per text message
 * - No message editing (unlike Telegram/Discord/Slack)
 * - No threads/embeds — plain text and media only
 *
 * GDPR notes (Eleiris/EU):
 * - Only the WhatsApp Business API is GDPR-compliant (not the app)
 * - Cloud API processes data through Meta infrastructure
 * - Requires explicit user opt-in for WhatsApp communication
 * - Consider EU-based BSP for data residency requirements
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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

export interface WhatsAppAdapterConfig {
	type: "whatsapp";
	/** Meta Cloud API access token (permanent, not temporary) */
	accessToken: string;
	/** WhatsApp Business phone number ID (not the phone number itself) */
	phoneNumberId: string;
	/** Webhook verification token (shared secret with Meta) */
	webhookVerifyToken: string;
	/** Port for the webhook HTTP server (default: 3000) */
	webhookPort?: number;
	/** Webhook URL path (default: /webhook) */
	webhookPath?: string;
	/** Cloud API version (default: v21.0) */
	apiVersion?: string;
}

const WA_MAX_MESSAGE_LENGTH = 4096;
const GRAPH_API_BASE = "https://graph.facebook.com";

// =============================================================================
// Per-channel (per-contact) run state
// =============================================================================

interface ChannelRunState {
	/** Last sent message ID (WhatsApp doesn't support editing) */
	lastMessageId: string | null;
	/** Accumulated text for the current response (sent as one message at the end) */
	accumulatedText: string;
	/** Whether the agent is currently working */
	isWorking: boolean;
	/** Serialized update queue */
	updatePromise: Promise<void>;
}

// =============================================================================
// WhatsAppAdapter
// =============================================================================

export class WhatsAppAdapter implements PlatformAdapter {
	readonly name = "whatsapp";

	private config: WhatsAppAdapterConfig;
	private apiBase: string;
	private server: Server | null = null;
	private onMessage: OnMessageCallback | null = null;
	private onStop: OnStopCallback | null = null;

	/** Known contacts (populated as messages arrive) */
	private contacts = new Map<string, UserInfo>();

	/** Per-contact run state */
	private runStates = new Map<string, ChannelRunState>();

	/** Track 24h service windows: phone → last incoming message timestamp */
	private serviceWindows = new Map<string, number>();
	private readonly SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

	constructor(config: WhatsAppAdapterConfig) {
		this.config = config;
		const version = config.apiVersion || "v21.0";
		this.apiBase = `${GRAPH_API_BASE}/${version}/${config.phoneNumberId}`;
	}

	// =========================================================================
	// PlatformAdapter implementation
	// =========================================================================

	async start(onMessage: OnMessageCallback, onStop: OnStopCallback): Promise<void> {
		this.onMessage = onMessage;
		this.onStop = onStop;

		const port = this.config.webhookPort || 3000;
		const path = this.config.webhookPath || "/webhook";

		this.server = createServer((req, res) => {
			this.handleWebhookRequest(req, res, path);
		});

		await new Promise<void>((resolve, reject) => {
			this.server!.listen(port, () => {
				log.logInfo(`[whatsapp] Webhook server listening on port ${port}${path}`);
				resolve();
			});
			this.server!.on("error", reject);
		});
	}

	async stop(): Promise<void> {
		if (this.server) {
			await new Promise<void>((resolve) => {
				this.server!.close(() => resolve());
			});
			this.server = null;
		}
		log.logInfo("[whatsapp] Stopped");
	}

	getChannels(): ChannelInfo[] {
		// WhatsApp doesn't have channels — each contact is a "channel"
		return Array.from(this.contacts.keys()).map((phone) => ({
			id: phone,
			name: this.contacts.get(phone)?.displayName || phone,
			type: "dm" as const,
		}));
	}

	getUsers(): UserInfo[] {
		return Array.from(this.contacts.values());
	}

	resetRunState(channelId: string): void {
		this.runStates.set(channelId, {
			lastMessageId: null,
			accumulatedText: "",
			isWorking: false,
			updatePromise: Promise.resolve(),
		});
	}

	async respond(channelId: string, text: string): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			try {
				// WhatsApp can't edit messages — accumulate and send at the end.
				// For intermediate updates, we just accumulate.
				state.accumulatedText = state.accumulatedText ? `${state.accumulatedText}\n${text}` : text;
			} catch (err) {
				log.logWarning("[whatsapp] respond error", err instanceof Error ? err.message : String(err));
			}
		});
		await state.updatePromise;
	}

	async replaceMessage(channelId: string, text: string): Promise<void> {
		const state = this.getRunState(channelId);
		state.updatePromise = state.updatePromise.then(async () => {
			state.accumulatedText = text;
		});
		await state.updatePromise;
	}

	async respondInThread(channelId: string, text: string): Promise<void> {
		// WhatsApp doesn't have threads — skip tool detail messages.
		// Only the final response (via setWorking(false) → flush) matters.
		void channelId;
		void text;
	}

	async setTyping(_channelId: string, _isTyping: boolean): Promise<void> {
		// WhatsApp Cloud API doesn't support typing indicators
	}

	async setWorking(channelId: string, working: boolean): Promise<void> {
		const state = this.getRunState(channelId);

		if (!working && state.accumulatedText) {
			// Agent finished — flush accumulated text as a single message
			state.updatePromise = state.updatePromise.then(async () => {
				try {
					await this.sendTextMessage(channelId, state.accumulatedText);
					state.accumulatedText = "";
				} catch (err) {
					log.logWarning("[whatsapp] flush error", err instanceof Error ? err.message : String(err));
				}
			});
			await state.updatePromise;
		}
	}

	async uploadFile(channelId: string, filePath: string, _title?: string): Promise<void> {
		// WhatsApp supports media messages but requires uploading to Meta's servers first.
		// For now, send a text note about the file.
		try {
			const { basename } = await import("path");
			const filename = basename(filePath);
			await this.sendTextMessage(channelId, `📎 File: ${filename}\n(File upload not yet implemented)`);
		} catch (err) {
			log.logWarning("[whatsapp] uploadFile error", err instanceof Error ? err.message : String(err));
		}
	}

	async deleteMessage(_channelId: string): Promise<void> {
		// WhatsApp doesn't support message deletion via API (for [SILENT] responses)
	}

	logBotResponse(_channelId: string, _text: string, _messageId: string): void {
		// Logging handled by the harness via ChannelStore
	}

	// =========================================================================
	// Webhook handling
	// =========================================================================

	private handleWebhookRequest(req: IncomingMessage, res: ServerResponse, path: string): void {
		const url = new URL(req.url || "/", `http://${req.headers.host}`);

		if (url.pathname !== path) {
			res.writeHead(404);
			res.end();
			return;
		}

		if (req.method === "GET") {
			this.handleVerification(url, res);
		} else if (req.method === "POST") {
			this.handleIncomingWebhook(req, res);
		} else {
			res.writeHead(405);
			res.end();
		}
	}

	/**
	 * Handle Meta's webhook verification challenge.
	 * GET /webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>
	 */
	private handleVerification(url: URL, res: ServerResponse): void {
		const mode = url.searchParams.get("hub.mode");
		const token = url.searchParams.get("hub.verify_token");
		const challenge = url.searchParams.get("hub.challenge");

		if (mode === "subscribe" && token === this.config.webhookVerifyToken) {
			log.logInfo("[whatsapp] Webhook verified");
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(challenge);
		} else {
			log.logWarning("[whatsapp] Webhook verification failed", `mode=${mode}`);
			res.writeHead(403);
			res.end();
		}
	}

	/**
	 * Handle incoming webhook notifications from Meta.
	 */
	private handleIncomingWebhook(req: IncomingMessage, res: ServerResponse): void {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			// Always respond 200 quickly (Meta retries on non-200)
			res.writeHead(200);
			res.end();

			try {
				const payload = JSON.parse(body) as WebhookPayload;
				this.processWebhookPayload(payload);
			} catch (err) {
				log.logWarning("[whatsapp] Failed to parse webhook", err instanceof Error ? err.message : String(err));
			}
		});
	}

	/**
	 * Process a webhook payload and extract messages.
	 */
	private processWebhookPayload(payload: WebhookPayload): void {
		if (payload.object !== "whatsapp_business_account") return;

		for (const entry of payload.entry || []) {
			for (const change of entry.changes || []) {
				if (change.field !== "messages") continue;
				const value = change.value;

				// Cache contact info
				for (const contact of value.contacts || []) {
					this.contacts.set(contact.wa_id, {
						id: contact.wa_id,
						username: contact.wa_id,
						displayName: contact.profile?.name || contact.wa_id,
					});
				}

				// Process messages
				for (const msg of value.messages || []) {
					this.handleIncomingMessage(msg, value.metadata);
				}
			}
		}
	}

	private handleIncomingMessage(msg: WebhookMessage, metadata: WebhookMetadata): void {
		// Only handle text messages for now
		if (msg.type !== "text" || !msg.text?.body) return;

		const text = msg.text.body;
		const from = msg.from; // Phone number in international format

		// Update service window
		this.serviceWindows.set(from, Date.now());

		log.logInfo(`[whatsapp] Message from ${from}: ${text.substring(0, 80)}`);

		// Check for stop command
		if (text.toLowerCase().trim() === "stop" && this.onStop) {
			this.onStop(from, this);
			return;
		}

		// Normalize to ChannelMessage
		const channelMessage: ChannelMessage = {
			id: msg.id,
			channelId: from,
			timestamp: new Date(Number.parseInt(msg.timestamp, 10) * 1000).toISOString(),
			sender: {
				id: from,
				username: from,
				displayName: this.contacts.get(from)?.displayName || from,
				isBot: false,
			},
			text,
			attachments: [],
			isMention: true, // WhatsApp is always direct
			metadata: {
				phoneNumberId: metadata.phone_number_id,
				displayPhoneNumber: metadata.display_phone_number,
				waMessageId: msg.id,
			},
		};

		if (this.onMessage) {
			this.onMessage(channelMessage, this);
		}
	}

	// =========================================================================
	// Message sending
	// =========================================================================

	/**
	 * Send a text message via the Cloud API.
	 * Checks if within the 24h service window.
	 */
	private async sendTextMessage(to: string, text: string): Promise<string | null> {
		// Check service window
		const lastIncoming = this.serviceWindows.get(to);
		if (!lastIncoming || Date.now() - lastIncoming > this.SERVICE_WINDOW_MS) {
			log.logWarning(
				"[whatsapp] Outside 24h service window",
				`Cannot send to ${to} — user must message first, or use a template`,
			);
			return null;
		}

		// Chunk if needed
		const chunks = this.splitMessage(text);
		let lastMessageId: string | null = null;

		for (const chunk of chunks) {
			lastMessageId = await this.sendSingleMessage(to, chunk);
		}

		return lastMessageId;
	}

	private async sendSingleMessage(to: string, text: string): Promise<string | null> {
		try {
			const res = await fetch(`${this.apiBase}/messages`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.config.accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					messaging_product: "whatsapp",
					recipient_type: "individual",
					to,
					type: "text",
					text: {
						preview_url: false,
						body: text,
					},
				}),
			});

			if (!res.ok) {
				const errBody = await res.text().catch(() => "");
				log.logWarning("[whatsapp] Send failed", `${res.status}: ${errBody}`);
				return null;
			}

			const json = (await res.json()) as { messages?: Array<{ id: string }> };
			return json.messages?.[0]?.id || null;
		} catch (err) {
			log.logWarning("[whatsapp] Send error", err instanceof Error ? err.message : String(err));
			return null;
		}
	}

	private splitMessage(text: string): string[] {
		if (text.length <= WA_MAX_MESSAGE_LENGTH) return [text];

		const parts: string[] = [];
		let remaining = text;

		while (remaining.length > 0) {
			if (remaining.length <= WA_MAX_MESSAGE_LENGTH) {
				parts.push(remaining);
				break;
			}
			let split = remaining.lastIndexOf("\n", WA_MAX_MESSAGE_LENGTH);
			if (split < WA_MAX_MESSAGE_LENGTH / 2) split = WA_MAX_MESSAGE_LENGTH;
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
				lastMessageId: null,
				accumulatedText: "",
				isWorking: false,
				updatePromise: Promise.resolve(),
			};
			this.runStates.set(channelId, state);
		}
		return state;
	}

	/**
	 * Check if we're within the 24h service window for a contact.
	 */
	isInServiceWindow(phoneNumber: string): boolean {
		const lastIncoming = this.serviceWindows.get(phoneNumber);
		if (!lastIncoming) return false;
		return Date.now() - lastIncoming < this.SERVICE_WINDOW_MS;
	}
}

// =============================================================================
// WhatsApp Cloud API webhook payload types
// =============================================================================

interface WebhookPayload {
	object: string;
	entry?: WebhookEntry[];
}

interface WebhookEntry {
	id: string;
	changes?: WebhookChange[];
}

interface WebhookChange {
	field: string;
	value: WebhookValue;
}

interface WebhookValue {
	messaging_product: string;
	metadata: WebhookMetadata;
	contacts?: WebhookContact[];
	messages?: WebhookMessage[];
	statuses?: WebhookStatus[];
}

interface WebhookMetadata {
	display_phone_number: string;
	phone_number_id: string;
}

interface WebhookContact {
	wa_id: string;
	profile?: {
		name?: string;
	};
}

interface WebhookMessage {
	from: string;
	id: string;
	timestamp: string;
	type: string;
	text?: {
		body: string;
	};
}

interface WebhookStatus {
	id: string;
	status: string;
	timestamp: string;
	recipient_id: string;
}
