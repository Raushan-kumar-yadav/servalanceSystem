import { useState, useRef, useEffect, useCallback } from 'react'
import './FloatingAIChat.css'

// ── Types ─────────────────────────────────────────────────────────────────────

type MsgRole = 'ai' | 'user' | 'tool_call' | 'tool_result' | 'error'
type Phase   = 'idle' | 'thinking' | 'responding' | 'tool'

interface Message {
  id: string
  role: MsgRole
  text: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  streaming?: boolean
}

interface AgentStatus {
  phase: Phase
  label: string
  tool?: string
}

const uid = () => Math.random().toString(36).slice(2, 9)

// ── Persistent module-level store ─────────────────────────────────────────────

const _WELCOME: Message = {
  id: 'welcome',
  role: 'ai',
  text: `Hi! I'm your AI Surveillance Analyst. Ask me what you see on camera, summarise footage, search recordings, detect threats, or check system status.\n\nTry: "What's happening right now?" or "Any threats in the last 5 minutes?"`,
}

let _msgs: Message[]                       = [_WELCOME]
let _hist: { role: string; text: string }[] = []
let _inp  = ''

// ── Tool icon map ─────────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  get_system_status:        '📡',
  list_recordings:          '📂',
  get_indexed_videos:       '🗂️',
  summarise_today_footage:  '📋',
  search_footage:           '🔍',
  detect_issues:            '⚠️',
  query_camera_events:      '📹',
  start_recording:          '🔴',
  stop_recording:           '⏹️',
  search_web:               '🌐',
  get_current_frame_info:   '👁️',
  get_recent_video_context: '🎞️',
}

// ── Quick-prompt chips ────────────────────────────────────────────────────────

const QUICK_PROMPTS = [
  { label: '👁️ What do you see?',        prompt: "What is currently happening on the cameras? Describe what you see right now." },
  { label: '⚠️ Any threats?',            prompt: "Detect any security threats or suspicious activity across all cameras." },
  { label: '📋 Summarise today',         prompt: "Summarise today's surveillance footage across all cameras." },
  { label: '🎞️ Last 5 mins',            prompt: "What happened in the last 5 minutes on all cameras?" },
  { label: '🔍 Search: person near fence', prompt: "Search footage for a person near a fence or boundary." },
  { label: '📡 System status',           prompt: "Check the current system status including cameras and recording state." },
]

// ── Status bar ────────────────────────────────────────────────────────────────

function StatusBar({ status }: { status: AgentStatus }) {
  if (status.phase === 'idle') return null
  return (
    <div className={`fchat__status-bar fchat__status-bar--${status.phase}`}>
      <span className="fchat__status-spinner" />
      <span className="fchat__status-label">{status.label}</span>
    </div>
  )
}

// ── Message bubble ────────────────────────────────────────────────────────────

function Bubble({ msg }: { msg: Message }) {
  const [expanded, setExpanded] = useState(false)

  if (msg.role === 'tool_call') {
    const icon    = TOOL_ICONS[msg.toolName ?? ''] ?? '⚙️'
    const hasArgs = msg.toolArgs && Object.keys(msg.toolArgs).length > 0
    const argsStr = hasArgs ? JSON.stringify(msg.toolArgs, null, 2) : ''
    return (
      <div className="fchat__tool-card fchat__tool-card--call">
        <span className="fchat__tool-icon fchat__tool-icon--spin">{icon}</span>
        <div className="fchat__tool-body">
          <div className="fchat__tool-name">{msg.toolName}</div>
          {hasArgs && (
            <>
              <button className="fchat__tool-expand" onClick={() => setExpanded(v => !v)}>
                {expanded ? '▲ hide args' : '▼ show args'}
              </button>
              {expanded && <pre className="fchat__tool-args">{argsStr}</pre>}
            </>
          )}
        </div>
        <span className="fchat__tool-badge fchat__tool-badge--running">running</span>
      </div>
    )
  }

  if (msg.role === 'tool_result') {
    const icon    = TOOL_ICONS[msg.toolName ?? ''] ?? '✓'
    const MAX     = 240
    const preview = msg.text.length > MAX ? msg.text.slice(0, MAX) + '…' : msg.text
    const truncated = msg.text.length > MAX
    return (
      <div className="fchat__tool-card fchat__tool-card--result">
        <span className="fchat__tool-icon">{icon}</span>
        <div className="fchat__tool-body">
          <div className="fchat__tool-name">{msg.toolName} <span className="fchat__tool-done">done</span></div>
          <div className="fchat__tool-summary">{expanded ? msg.text : preview}</div>
          {truncated && (
            <button className="fchat__tool-expand" onClick={() => setExpanded(v => !v)}>
              {expanded ? '▲ less' : '▼ more'}
            </button>
          )}
        </div>
        <span className="fchat__tool-badge fchat__tool-badge--done">✓</span>
      </div>
    )
  }

  return (
    <div className={`fchat__msg fchat__msg--${msg.role === 'error' ? 'error' : msg.role}`}>
      {msg.role === 'ai' && (
        <div className={`fchat__avatar ${msg.streaming ? 'fchat__avatar--pulse' : ''}`}>AI</div>
      )}
      <div className="fchat__bubble">
        {msg.text || (msg.streaming ? <span className="fchat__cursor">▋</span> : null)}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props { onClose: () => void }

export default function FloatingAIChat({ onClose }: Props) {
  const port   = (window as any).__FADE_PORT__   ?? 8000
  const scheme = (window as any).__FADE_SCHEME__ ?? 'http'
  const base   = `${scheme}://127.0.0.1:${port}`

  const [messages, setMessages] = useState<Message[]>(_msgs)
  const [input,    setInput]    = useState(_inp)
  const [busy,     setBusy]     = useState(false)
  const [status,   setStatus]   = useState<AgentStatus>({ phase: 'idle', label: '' })
  const [showChips, setShowChips] = useState(true)

  // Widget position & size
  const [pos,  setPos]  = useState({ x: window.innerWidth - 450, y: 72 })
  const [size, setSize] = useState({ w: 430, h: 560 })

  const bottomRef  = useRef<HTMLDivElement>(null)
  const abortRef   = useRef<AbortController | null>(null)
  const historyRef = useRef(_hist)
  const inputRef   = useRef<HTMLTextAreaElement>(null)
  const dragRef    = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const resizeRef  = useRef<{ sx: number; sy: number; ow: number; oh: number } | null>(null)

  useEffect(() => { _msgs = messages }, [messages])
  useEffect(() => { _inp  = input    }, [input])

  const scrollBottom = useCallback(() => {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 40)
  }, [])

  const appendMsg = useCallback((msg: Message) => {
    setMessages(prev => { const n = [...prev, msg]; _msgs = n; return n })
    scrollBottom()
  }, [scrollBottom])

  const patchLast = useCallback((patch: Partial<Message>) => {
    setMessages(prev => {
      const copy = [...prev]
      copy[copy.length - 1] = { ...copy[copy.length - 1], ...patch }
      _msgs = copy
      return copy
    })
  }, [])

  async function send(overrideText?: string) {
    const text = (overrideText ?? input).trim()
    if (!text || busy) return
    setInput(''); _inp = ''
    setShowChips(false)
    setBusy(true)
    setStatus({ phase: 'thinking', label: 'Thinking…' })

    appendMsg({ id: uid(), role: 'user', text })
    historyRef.current = [...historyRef.current, { role: 'user', text }]
    _hist = historyRef.current

    const aiId = uid()
    appendMsg({ id: aiId, role: 'ai', text: '', streaming: true })
    let aiText = ''
    abortRef.current = new AbortController()

    try {
      const res = await fetch(`${base}/ai/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: text, history: historyRef.current.slice(-20), port }),
        signal:  abortRef.current.signal,
      })
      const reader  = res.body!.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.decode(value).split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const evt = JSON.parse(line.slice(6))

            if (evt.type === 'status') {
              setStatus({ phase: evt.phase as Phase, label: evt.label, tool: evt.tool })

            } else if (evt.type === 'token') {
              aiText += evt.content
              patchLast({ text: aiText, streaming: true })
              scrollBottom()

            } else if (evt.type === 'tool_call') {
              setMessages(prev => {
                const last = prev[prev.length - 1]
                if (last?.role === 'ai' && !last.text) {
                  const n = prev.slice(0, -1); _msgs = n; return n
                }
                return prev
              })
              appendMsg({ id: uid(), role: 'tool_call', text: '', toolName: evt.name, toolArgs: evt.args })

            } else if (evt.type === 'tool_result') {
              appendMsg({ id: uid(), role: 'tool_result', text: evt.content, toolName: evt.name })
              appendMsg({ id: uid(), role: 'ai', text: '', streaming: true })
              aiText = ''

            } else if (evt.type === 'done') {
              patchLast({ streaming: false })
              setMessages(prev => {
                const f = prev.filter((m, i) => i === 0 || m.text !== '' || m.role !== 'ai')
                _msgs = f; return f
              })

            } else if (evt.type === 'error') {
              patchLast({ text: `⚠ ${evt.message}`, streaming: false, role: 'error' })
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError')
        patchLast({ text: `⚠ ${err.message}`, streaming: false, role: 'error' })
    }

    historyRef.current = [...historyRef.current, { role: 'ai', text: aiText }]
    _hist = historyRef.current
    setStatus({ phase: 'idle', label: '' })
    setBusy(false)
  }

  function stop() {
    abortRef.current?.abort()
    setStatus({ phase: 'idle', label: '' })
    setBusy(false)
  }

  function clearChat() {
    setMessages([_WELCOME]); _msgs = [_WELCOME]
    historyRef.current = []; _hist = []
    setShowChips(true)
  }

  // ── Drag to move ──────────────────────────────────────────────────────────
  function onHeaderMouseDown(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y }
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      setPos({
        x: Math.max(0, Math.min(window.innerWidth  - size.w, dragRef.current.ox + ev.clientX - dragRef.current.sx)),
        y: Math.max(0, Math.min(window.innerHeight - 60,     dragRef.current.oy + ev.clientY - dragRef.current.sy)),
      })
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ── Drag to resize ────────────────────────────────────────────────────────
  function onResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation()
    resizeRef.current = { sx: e.clientX, sy: e.clientY, ow: size.w, oh: size.h }
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      setSize({
        w: Math.max(340, Math.min(820, resizeRef.current.ow + ev.clientX - resizeRef.current.sx)),
        h: Math.max(320, Math.min(900, resizeRef.current.oh + ev.clientY - resizeRef.current.sy)),
      })
    }
    const onUp = () => {
      resizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const glowClass =
    status.phase === 'thinking'   ? 'fchat__input-wrap--thinking'  :
    status.phase === 'responding' ? 'fchat__input-wrap--responding' :
    status.phase === 'tool'       ? 'fchat__input-wrap--tool'       : ''

  return (
    <div
      className={`fchat ${busy ? 'fchat--busy' : ''}`}
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
    >
      {/* Header */}
      <div className="fchat__header" onMouseDown={onHeaderMouseDown}>
        <span className="fchat__title">
          <span className="fchat__online-dot" />
          AI Surveillance Analyst
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            title="Clear chat"
            onClick={clearChat}
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 13, padding: '0 4px' }}
          >↺</button>
          <button className="fchat__close" onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      <StatusBar status={status} />

      {/* Messages */}
      <div className="fchat__messages">
        {messages.map(m => <Bubble key={m.id} msg={m} />)}
        <div ref={bottomRef} />
      </div>

      {/* Quick-prompt chips */}
      {showChips && messages.length <= 1 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 5, padding: '6px 12px 4px',
          borderTop: '1px solid rgba(255,255,255,0.05)',
        }}>
          {QUICK_PROMPTS.map(qp => (
            <button
              key={qp.label}
              onClick={() => send(qp.prompt)}
              disabled={busy}
              style={{
                background: 'rgba(124,111,255,0.1)', border: '1px solid rgba(124,111,255,0.2)',
                color: '#c4bcff', borderRadius: 20, padding: '4px 10px',
                fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
                transition: 'background 0.2s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(124,111,255,0.22)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(124,111,255,0.1)')}
            >
              {qp.label}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="fchat__input-row">
        <div className={`fchat__input-wrap ${glowClass}`}>
          <textarea
            ref={inputRef}
            className="fchat__input"
            placeholder={busy ? 'AI is working…' : 'Ask about cameras, footage, threats…'}
            value={input}
            rows={2}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            disabled={busy}
          />
        </div>
        {busy
          ? <button className="fchat__send fchat__send--stop" onClick={stop} title="Stop">■</button>
          : <button className="fchat__send" onClick={() => send()} title="Send (Enter)">↑</button>
        }
      </div>

      {/* Resize handle */}
      <div className="fchat__resize-handle" onMouseDown={onResizeMouseDown} />
    </div>
  )
}
