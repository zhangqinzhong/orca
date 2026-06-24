/**
 * Claude Chat Session — 封装 @anthropic-ai/claude-agent-sdk
 */
import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk'
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
  permissionMode?: Options['permissionMode']
}

// Why: the SDK types are massive union types. Work with the raw message shape
// instead of importing them, to avoid version-sensitive type dependencies.
type RawSDKMsg = {
  type: string
  message?: {
    content?: {
      type: string
      text?: string
      name?: string
      input?: unknown
    }[]
  }
}

export class ClaudeChatSession extends EventEmitter {
  private queryInstance: Query | null = null
  private options: Options

  constructor(opts: ClaudeChatSessionOptions) {
    super()

    this.options = {
      cwd: opts.cwd,
      model: opts.model,
      permissionMode: opts.permissionMode ?? 'bypassPermissions'
    }
  }

  async start(userMessage: string): Promise<void> {
    try {
      this.queryInstance = query({ prompt: userMessage, options: this.options })

      for await (const message of this.queryInstance) {
        const chatMessages = this.translateMessage(message as RawSDKMsg)
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

  private translateMessage(message: RawSDKMsg): ChatMessage[] {
    const results: ChatMessage[] = []

    switch (message.type) {
      case 'assistant': {
        const blocks = message.message?.content
        if (blocks) {
          for (const block of blocks) {
            if (block.type === 'text' && block.text) {
              results.push({ type: 'assistant', text: block.text, messageId: randomUUID() })
            } else if (block.type === 'tool_use') {
              results.push({
                type: 'tool_use',
                name: block.name ?? 'unknown',
                input: block.input,
                messageId: randomUUID()
              })
            }
          }
        }
        break
      }
      case 'result':
      case 'system':
        break
      default:
        break
    }

    return results
  }
}
