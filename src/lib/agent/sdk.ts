import type Anthropic from '@anthropic-ai/sdk';

// The beta Messages types this app uses (beta: for server-side fallbacks).
export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type Message = Anthropic.Beta.Messages.BetaMessage;
export type Tool = Anthropic.Beta.Messages.BetaTool;
export type ToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
export type ToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
