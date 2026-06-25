import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Send } from 'lucide-react'

type ChatMsg =
  | { type: 'user'; text: string; messageId: string }
  | { type: 'assistant'; text: string; messageId: string }
  | { type: 'tool_use'; name: string; input: unknown; messageId: string }
  | { type: 'tool_result'; content: string; messageId: string }
  | { type: 'error'; text: string; messageId: string }
  | { type: 'done'; messageId: string }

export default function AgentChatPanel(): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const sessionIdRef = useRef(crypto.randomUUID())

  useEffect(() => {
    const cleanup = window.api.agentChat.onMessage(
      (data: { sessionId: string; message: unknown }) => {
        const msg = data.message as ChatMsg
        setMessages((prev) => {
          if (msg.type === 'done' && prev.some((m) => m.type === 'done')) {
            return prev
          }
          return [...prev, msg]
        })

        if (msg.type === 'done') {
          setRunning(false)
        }
      }
    )
    return cleanup
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text) {
      return
    }

    setMessages((prev) => [...prev, { type: 'user', text, messageId: crypto.randomUUID() }])
    setInput('')
    setRunning(true)

    const sid = sessionIdRef.current

    try {
      const isFirst = messages.length === 0
      await (isFirst
        ? window.api.agentChat.start({ sessionId: sid, message: text, cwd: '' })
        : window.api.agentChat.continue({ sessionId: sid, message: text, cwd: '' }))
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          type: 'error',
          text: err instanceof Error ? err.message : String(err),
          messageId: crypto.randomUUID()
        }
      ])
      setRunning(false)
    }
  }, [input, messages.length])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <p className="text-muted-foreground text-sm text-center mt-8">
            Start a conversation with Claude
          </p>
        )}

        {messages.map((msg) => (
          <ChatBubble key={msg.messageId} msg={msg} />
        ))}

        {running && (
          <p className="text-muted-foreground text-xs animate-pulse">Claude is thinking...</p>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border p-3">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message..."
            className="flex-1 min-h-[40px] max-h-[120px] resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={running}
            rows={1}
          />
          <Button
            size="icon"
            onClick={handleSend}
            disabled={running || !input.trim()}
            className="shrink-0"
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function ChatBubble({ msg }: { msg: ChatMsg }): React.JSX.Element {
  switch (msg.type) {
    case 'user':
      return (
        <div className="flex justify-end">
          <Card className="max-w-[80%] px-3 py-2 bg-primary text-primary-foreground rounded-lg">
            <p className="text-sm whitespace-pre-wrap">{msg.text}</p>
          </Card>
        </div>
      )

    case 'assistant':
      return (
        <div className="flex justify-start">
          <Card className="max-w-[80%] px-3 py-2 bg-card rounded-lg">
            <p className="text-sm whitespace-pre-wrap">{msg.text}</p>
          </Card>
        </div>
      )

    case 'tool_use':
      return (
        <div className="flex justify-start">
          <Card className="max-w-[80%] px-3 py-2 bg-muted rounded-lg border-l-2 border-blue-400">
            <p className="text-xs text-muted-foreground font-mono">&#x1f527; {msg.name}</p>
            <p className="text-xs text-muted-foreground font-mono truncate">
              {JSON.stringify(msg.input)}
            </p>
          </Card>
        </div>
      )

    case 'error':
      return (
        <div className="flex justify-center">
          <p className="text-xs text-destructive">{msg.text}</p>
        </div>
      )

    case 'done':
      return (
        <div className="flex justify-center">
          <p className="text-xs text-muted-foreground">— done —</p>
        </div>
      )

    default:
      return (
        <div className="flex justify-center">
          <p className="text-xs text-muted-foreground">{msg.type}</p>
        </div>
      )
  }
}
