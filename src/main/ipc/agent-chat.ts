/**
 * Agent Chat IPC — 桥接渲染进程和主进程的 ClaudeChatSession
 */
import { ipcMain, BrowserWindow } from 'electron'
import { ClaudeChatSession, type ChatMessage } from '../agent-chat/claude-chat-session'

export function registerAgentChatHandlers(): void {
  ipcMain.handle(
    'agent:chat:start',
    async (event, args: { sessionId: string; message: string; cwd: string }): Promise<void> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) {
        return
      }

      const session = new ClaudeChatSession({ cwd: args.cwd })

      session.on('message', (msg: ChatMessage) => {
        try {
          win.webContents.send('agent:chat:message', {
            sessionId: args.sessionId,
            message: msg
          })
        } catch {
          // webContents might be destroyed
        }
      })

      await session.start(args.message)
    }
  )

  ipcMain.handle(
    'agent:chat:continue',
    async (event, args: { sessionId: string; message: string; cwd: string }): Promise<void> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) {
        return
      }

      const session = new ClaudeChatSession({ cwd: args.cwd })

      session.on('message', (msg: ChatMessage) => {
        try {
          win.webContents.send('agent:chat:message', {
            sessionId: args.sessionId,
            message: msg
          })
        } catch {
          // webContents might be destroyed
        }
      })

      await session.start(args.message)
    }
  )

  ipcMain.handle('agent:chat:stop', (_event, _args: { sessionId: string }): void => {
    // sessions are short-lived — we no longer need the map, just interrupt
  })
}
