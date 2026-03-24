/**
 * Adapter registry — creates platform adapters from configuration.
 */

export { DiscordAdapter, type DiscordAdapterConfig } from "./discord.js";
export { SlackAdapter, type SlackAdapterConfig } from "./slack.js";
export { TelegramAdapter, type TelegramAdapterConfig } from "./telegram.js";
export type {
	AdapterConfig,
	ChannelAttachment,
	ChannelInfo,
	ChannelMessage,
	MomConfig,
	OnMessageCallback,
	OnStopCallback,
	PlatformAdapter,
	RespondOptions,
	UserInfo,
} from "./types.js";
export { WhatsAppAdapter, type WhatsAppAdapterConfig } from "./whatsapp.js";

import { DiscordAdapter, type DiscordAdapterConfig } from "./discord.js";
import { SlackAdapter, type SlackAdapterConfig } from "./slack.js";
import { TelegramAdapter, type TelegramAdapterConfig } from "./telegram.js";
import type { AdapterConfig, PlatformAdapter } from "./types.js";
import { WhatsAppAdapter, type WhatsAppAdapterConfig } from "./whatsapp.js";

/**
 * Create an adapter from its configuration.
 */
export function createAdapter(_name: string, config: AdapterConfig): PlatformAdapter {
	switch (config.type) {
		case "slack":
			return new SlackAdapter(config as unknown as SlackAdapterConfig);

		case "telegram":
			return new TelegramAdapter(config as unknown as TelegramAdapterConfig);

		case "discord":
			return new DiscordAdapter(config as unknown as DiscordAdapterConfig);

		case "whatsapp":
			// ⚠️ See whatsapp.ts header for Meta policy restrictions (Jan 2026).
			// General-purpose AI chatbots are prohibited on WhatsApp Business API.
			return new WhatsAppAdapter(config as unknown as WhatsAppAdapterConfig);

		default:
			throw new Error(`Unknown adapter type: ${config.type}`);
	}
}
