/**
 * Claude Chat Session — 封装 @anthropic-ai/claude-agent-sdk
 *
 * spawn Claude Code 子进程，通过 stream-json 获取结构化消息，
 * 把 SDKMessage 转成统一的 ChatMessage 格式抛给 IPC。
 */
import {
  query,
  type Options,
  type Query,
  type Message as SDKMessage
} from '@anthropic-ai/claude-agent-sdk'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

export type ChatMessage =
  | { type: 'user'; text: string; messageId: string }
  | { type: 'assistant'; text: string; messageId: string }
  | { type: 'tool_use'; name: string; input: unknown; messageId: string }
  | { type: 'tool_result'; content: string; messageId: string }
  | { type: 'error'; text: string }
  | { type: 'done' }

export type ClaudeChatSessionOptions = {
  cwd: string
  model?: string
  systemPrompt?: string
  permissionMode?: Options['permissionMode']
}

export class ClaudeChatSession extends EventEmitter {
  private queryInstance: Query | null = null
  private cwd: string
  private options: Options

  constructor(opts: ClaudeChatSessionOptions) {
    super()
    this.cwd = opts.cwd

    this.options = {
      cwd: opts.cwd,
      model: opts.model,
      // Why: agent-office is a GUI, so permissions are handled by the host.
      // 'bypassPermissions' avoids blocking on terminal prompts.
      permissionMode: opts.permissionMode ?? 'bypassPermissions',
      // Why: structured JSON output — no ANSI to parse.
      outputFormat: { type: 'stream_json' }
    }
  }

  async start(userMessage: string): Promise<void> {
    const input = {
      prompt: userMessage,
      options: this.options
    }

    try {
      this.queryInstance = query(input)

      for await (const message of this.queryInstance) {
        const chatMessages = this.translateMessage(message)
        for (const msg of chatMessages) {
          this.emit('message', msg)
        }
      }

      this.emit('message', { type: 'done' as const })
    } catch (error) {
      this.emit('message', {
        type: 'error' as const,
        text: error instanceof Error ? error.message : String(error)
      })
    }
  }

  stop(): void {
    this.queryInstance?.interrupt()
  }

  private translateMessage(message: SDKMessage): ChatMessage[] {
    const results: ChatMessage[] = []
    const messageId = randomUUID()

    switch (message.type) {
      case 'user':
        if (message.message?.content) {
          results.push({
            type: 'user',
            text: flattenContent(message.message.content),
            messageId
          })
        }
        break

      case 'assistant':
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            results.push({ type: 'assistant', text: block.text, messageId: randomUUID() })
          } else if (block.type === 'tool_use') {
            results.push({
              type: 'tool_use',
              name: block.name,
              input: block.input,
              messageId: randomUUID()
            })
          }
        }
        break

      case 'result':
      case 'system':
        // skip system-level messages for now
        break

      default:
        break
    }

    return results
  }
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: 'text'; text: string } => b?.type === 'text')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}
