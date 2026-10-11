import { z } from 'zod';

export const contextModeSchema = z.enum(['auto', 'full', 'selection']);
export type ContextMode = z.infer<typeof contextModeSchema>;
export const readingBlockSchema = z.object({
  id: z.string().min(1).max(160),
  kind: z.enum(['heading', 'paragraph', 'code', 'math', 'caption', 'table']),
  text: z.string().max(200_000),
  sectionPath: z.array(z.string().max(300)).max(20).default([]),
});
export const readingDocumentSchema = z
  .object({
    key: z.string().min(1).max(4096),
    revision: z.string().min(1).max(160),
    title: z.string().max(1000),
    url: z.string().max(4096).optional(),
    language: z.string().max(80).optional(),
    blocks: z.array(readingBlockSchema).max(10_000),
    warnings: z.array(z.string().max(300)).max(20).default([]),
  })
  .refine((d) => new Set(d.blocks.map((b) => b.id)).size === d.blocks.length, '文档段落 ID 重复。')
  .refine(
    (d) => new TextEncoder().encode(JSON.stringify(d)).byteLength <= 5 * 1024 * 1024,
    '文章内容超过 5 MiB。',
  );
export type ReadingDocument = z.infer<typeof readingDocumentSchema>;
export type ReadingBlock = z.infer<typeof readingBlockSchema>;
export const quoteSchema = z.object({
  id: z.string().min(1).max(160),
  documentKey: z.string().min(1).max(4096),
  revision: z.string().max(160),
  label: z.string().max(300),
  text: z.string().min(1).max(50_000),
  originalText: z.string().max(50_000).optional(),
  kind: z.enum(['text', 'code']),
  blockIds: z.array(z.string().max(160)).max(100).default([]),
});
export type Quote = z.infer<typeof quoteSchema>;
export const userMessageSchema = z.object({
  id: z.string().min(1).max(160),
  role: z.literal('user'),
  text: z.string().min(1).max(50_000),
  quotes: z.array(quoteSchema).max(20),
  createdAt: z.number().finite(),
});
export type UserMessage = z.infer<typeof userMessageSchema>;
export const assistantMessageSchema = z.object({
  id: z.string().min(1).max(160),
  role: z.literal('assistant'),
  text: z.string().max(200_000),
  status: z.enum(['streaming', 'completed', 'interrupted', 'error']),
  createdAt: z.number().finite(),
  error: z.string().max(1000).optional(),
  model: z.string().max(200).optional(),
  context: z
    .object({
      coverage: z.enum(['full', 'partial', 'selection']),
      blocks: z.number(),
      totalBlocks: z.number(),
      inputTokens: z.number(),
    })
    .optional(),
});
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export const messageSchema = z.discriminatedUnion('role', [userMessageSchema, assistantMessageSchema]);
export type ChatMessage = z.infer<typeof messageSchema>;
export const summarySchema = z.object({ throughId: z.string().max(160), text: z.string().max(16_000) });
export type ConversationSummary = z.infer<typeof summarySchema>;
export const draftSchema = z.object({
  text: z.string().max(50_000),
  quotes: z.array(quoteSchema).max(20),
  mode: contextModeSchema,
});
export const conversationSchema = z.object({
  key: z.string().min(1).max(4096),
  title: z.string().max(1000),
  url: z.string().max(4096).optional(),
  revision: z.string().max(160),
  version: z.number().int().nonnegative(),
  updatedAt: z.number().finite(),
  messages: z.array(messageSchema).max(2000),
  draft: draftSchema,
  summary: summarySchema.optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export interface ConversationStore {
  get(key: string): Promise<Conversation | undefined>;
  save(conversation: Conversation, expectedVersion: number): Promise<Conversation>;
  list(): Promise<Conversation[]>;
  delete(key: string): Promise<void>;
}
export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface ChatRequest {
  messages: readonly ChatTurn[];
  maxOutputTokens: number;
}
export interface ChatUsage {
  input: number;
  output: number;
  total: number;
}
export type ProviderEvent = { type: 'delta'; text: string } | { type: 'done'; usage?: ChatUsage };
export interface ChatProvider {
  stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
export interface ContextBudget {
  maxInputTokens: number;
  contextWindowTokens: number;
  maxOutputTokens: number;
}
export interface ContextInfo {
  coverage: 'full' | 'partial' | 'selection';
  blocks: number;
  totalBlocks: number;
  inputTokens: number;
}
export interface AssistantInput {
  document: ReadingDocument;
  question: UserMessage;
  history: readonly ChatMessage[];
  summary?: ConversationSummary;
  mode: ContextMode;
  budget: ContextBudget;
  preferences?: string;
  terminology?: readonly { source: string; target: string; policy: string }[];
}
export type AssistantEvent =
  | ProviderEvent
  | { type: 'context'; info: ContextInfo }
  | { type: 'compacting' }
  | { type: 'summary'; summary: ConversationSummary };
