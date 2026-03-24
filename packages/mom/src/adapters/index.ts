/**
 * Adapter registry — creates platform adapters from configuration.
 */

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

import { TelegramAdapter, type TelegramAdapterConfig } from "./telegram.js";
import type { AdapterConfig, PlatformAdapter } from "./types.js";

/**
 * Create an adapter from its configuration.
 */
export function createAdapter(_name: string, config: AdapterConfig): PlatformAdapter {
	switch (config.type) {
		case "telegram":
			return new TelegramAdapter(config as unknown as TelegramAdapterConfig);

		// Future adapters:
		// case "slack":
		//   return new SlackAdapter(config as unknown as SlackAdapterConfig);
		// case "discord":
		//   return new DiscordAdapter(config as unknown as DiscordAdapterConfig);

		default:
			throw new Error(`Unknown adapter type: ${config.type}`);
	}
}
