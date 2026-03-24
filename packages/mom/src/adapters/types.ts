/**
 * Platform adapter abstraction for mom.
 *
 * Adapters handle platform-specific I/O (connecting, receiving messages,
 * sending responses). The agent core is platform-agnostic — it just processes
 * messages and emits events.
 *
 * Based on the design in docs/new.md, adapted for practical implementation.
 */

// =============================================================================
// Core message types (platform-agnostic)
// =============================================================================

/**
 * A message from any platform, normalized to a common format.
 */
export interface ChannelMessage {
	/** Unique ID within the channel (platform-specific format preserved) */
	id: string;

	/** Channel/conversation ID */
	channelId: string;

	/** Timestamp (ISO 8601) */
	timestamp: string;

	/** Sender info */
	sender: {
		id: string;
		username: string;
		displayName?: string;
		isBot: boolean;
	};

	/** Message content (plain text, platform mentions normalized to @username) */
	text: string;

	/** Optional: original platform-specific text (for debugging) */
	rawText?: string;

	/** Attachments */
	attachments: ChannelAttachment[];

	/** Is this a direct mention/trigger of the bot? */
	isMention: boolean;

	/** Optional: reply-to message ID (for threaded conversations) */
	replyTo?: string;

	/** Platform-specific metadata */
	metadata?: Record<string, unknown>;
}

export interface ChannelAttachment {
	/** Original filename */
	filename: string;

	/** Local path (relative to channel dir) after download */
	localPath: string;

	/** MIME type if known */
	mimeType?: string;

	/** File size in bytes */
	size?: number;
}

// =============================================================================
// Platform adapter interface
// =============================================================================

export interface ChannelInfo {
	id: string;
	name: string;
	type: "channel" | "dm" | "group";
}

export interface UserInfo {
	id: string;
	username: string;
	displayName?: string;
}

/**
 * Callback for when a message arrives from the platform.
 * The adapter calls this; the harness routes it to the agent.
 */
export type OnMessageCallback = (message: ChannelMessage, adapter: PlatformAdapter) => Promise<void>;

/**
 * Callback for when a stop command is received.
 */
export type OnStopCallback = (channelId: string, adapter: PlatformAdapter) => Promise<void>;

/**
 * Platform adapter — handles all platform-specific I/O.
 *
 * Adapters are responsible for:
 * - Connecting to the platform (WebSocket, long-polling, webhook, etc.)
 * - Receiving messages and normalizing them to ChannelMessage
 * - Sending/updating/deleting messages in platform-native format
 * - Converting markdown to platform format (mrkdwn, MarkdownV2, etc.)
 * - File uploads and downloads
 *
 * Adapters are NOT responsible for:
 * - Agent logic, tool execution, or LLM calls
 * - Session/context management
 * - Memory or skills
 */
export interface PlatformAdapter {
	/** Adapter name (used in channel paths, e.g., "slack", "telegram", "discord") */
	readonly name: string;

	/** Start the adapter (connect to platform, begin receiving messages) */
	start(onMessage: OnMessageCallback, onStop: OnStopCallback): Promise<void>;

	/** Stop the adapter (disconnect, clean up) */
	stop(): Promise<void>;

	/** Get all known channels/conversations */
	getChannels(): ChannelInfo[];

	/** Get all known users */
	getUsers(): UserInfo[];

	// =========================================================================
	// Response rendering — adapters handle platform-specific formatting
	// =========================================================================

	/**
	 * Send or append to the main response message for a channel.
	 * Called multiple times during a run as the agent produces output.
	 * The adapter decides how to render (edit existing message, post new, etc.)
	 */
	respond(channelId: string, text: string, options?: RespondOptions): Promise<void>;

	/**
	 * Replace the entire main response message content.
	 */
	replaceMessage(channelId: string, text: string): Promise<void>;

	/**
	 * Send a message in a thread/detail area (e.g., Slack thread, Discord embed).
	 * Used for tool results, usage stats, verbose output.
	 */
	respondInThread(channelId: string, text: string): Promise<void>;

	/**
	 * Show/hide typing/working indicator.
	 */
	setTyping(channelId: string, isTyping: boolean): Promise<void>;

	/**
	 * Show/hide a "working" indicator (e.g., appending "..." to message).
	 */
	setWorking(channelId: string, working: boolean): Promise<void>;

	/**
	 * Upload a file to the channel.
	 */
	uploadFile(channelId: string, filePath: string, title?: string): Promise<void>;

	/**
	 * Delete the current response message (and thread messages if applicable).
	 * Used for [SILENT] responses.
	 */
	deleteMessage(channelId: string): Promise<void>;

	/**
	 * Log a bot response to the channel store.
	 * Called after the agent finishes responding.
	 */
	logBotResponse(channelId: string, text: string, messageId: string): void;

	/**
	 * Reset per-run state for a channel (clear accumulated text, message IDs, etc.)
	 * Called at the start of each agent run.
	 */
	resetRunState(channelId: string): void;

	/**
	 * Convert standard markdown to platform-specific format.
	 * Called by the harness before passing text to respond/replaceMessage.
	 * Return null to skip conversion (adapter handles it internally).
	 */
	formatMarkdown?(text: string): string;

	/**
	 * Download attachments from a platform message to local disk.
	 * Returns updated attachments with localPath populated.
	 */
	downloadAttachments?(channelId: string, message: ChannelMessage): Promise<ChannelAttachment[]>;
}

export interface RespondOptions {
	/** Whether to log this response to the channel store (default: true) */
	shouldLog?: boolean;
}

// =============================================================================
// Adapter configuration
// =============================================================================

/**
 * Configuration for a single adapter instance.
 * Stored in config.json under adapters.<name>.
 */
export interface AdapterConfig {
	/** Adapter type: "slack", "telegram", "discord", "whatsapp" */
	type: string;

	/** Adapter-specific configuration (tokens, webhook URLs, etc.) */
	[key: string]: unknown;
}

/**
 * Top-level mom configuration.
 */
export interface MomConfig {
	adapters: Record<string, AdapterConfig>;
}
