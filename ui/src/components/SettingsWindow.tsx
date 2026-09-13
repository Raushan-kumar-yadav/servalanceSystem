import { useState, useEffect, useCallback } from 'react'

interface MobileCam {
  id: string
  name: string
  connected: boolean
  last_seen: number
}

interface Props {
  port: number
  lanIp: string
  scheme?: string
  onClose: () => void
  onCamerasChanged: () => void
}

/** Fallback clipboard copy using hidden textarea — works in Electron. */
function execCopy(text: string) {
  const el = document.createElement('textarea')
  el.value = text
  el.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
  document.body.appendChild(el)
  el.focus(); el.select()
  try { document.execCommand('copy') } catch (_) {}
  document.body.removeChild(el)
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1800) }
    // Try modern clipboard API first, fall back to execCommand for Electron
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {
        execCopy(text); done()
      })
    } else {
      execCopy(text); done()
    }
  }
  return (
    <button onClick={copy} style={{
      background: copied ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.08)',
      border: `1px solid ${copied ? 'rgba(34,197,94,0.4)' : 'rgba(255,255,255,0.12)'}`,
      color: copied ? '#86efac' : 'rgba(255,255,255,0.6)',
      fontSize: 11, borderRadius: 6, padding: '3px 10px',
      cursor: 'pointer', transition: 'all 0.2s', whiteSpace: 'nowrap',
      fontFamily: "'Inter', sans-serif",
    }}>
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  )
}

function StatusDot({ ok }: { ok: boolean }) {
  const c = ok ? '#22c55e' : '#6b7280'
  return <span style={{
    display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
    background: c, boxShadow: ok ? `0 0 6px ${c}` : 'none', flexShrink: 0,
  }} />
}

export default function SettingsWindow({ port, lanIp, scheme, onClose, onCamerasChanged }: Props) {
  const [cameras,    setCameras]   = useState<MobileCam[]>([])
  const [newName,    setNewName]   = useState('Mobile Camera')
  const [adding,     setAdding]    = useState(false)
  const [newCam,     setNewCam]    = useState<{ id: string; name: string } | null>(null)
  const [recDir,     setRecDir]    = useState('')
  const [savingDir,  setSavingDir] = useState(false)
  const [saveDirMsg, setSaveDirMsg] = useState<string | null>(null)
  // Telegram
  const [tgToken,    setTgToken]   = useState('')
  const [tgChatId,   setTgChatId]  = useState('')
  const [tgStatus,   setTgStatus]  = useState<{configured:boolean;bot?:string;error?:string}|null>(null)
  const [tgSaving,   setTgSaving]  = useState(false)
  const [tgTesting,  setTgTesting] = useState(false)
  const _scheme = scheme ?? (window as any).__FADE_SCHEME__ ?? 'http'
  const base = `${_scheme}://127.0.0.1:${port}`

  const fetchCameras = useCallback(() => {
    fetch(`${base}/config/cameras`)
      .then(r => r.json())
      .then(data => setCameras(Array.isArray(data) ? data : []))
      .catch(() => setCameras([]))
  }, [base])

  useEffect(() => {
    fetchCameras()
    const t = setInterval(fetchCameras, 2000)
    return () => clearInterval(t)
  }, [fetchCameras])

  // Load recording dir on open
  useEffect(() => {
    fetch(`${base}/recordings/dir`)
      .then(r => r.json()).then(d => setRecDir(d.dir ?? '')).catch(() => {})
  }, [base])

  // Load Telegram status
  useEffect(() => {
    fetch(`${base}/detection/telegram/status`)
      .then(r => r.json())
      .then(d => setTgStatus(d))
      .catch(() => {})
  }, [base])

  const saveTelegram = async () => {
    setTgSaving(true)
    try {
      // Write to .env via backend config endpoint
      await fetch(`${base}/config/env`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ TELEGRAM_BOT_TOKEN: tgToken, TELEGRAM_CHAT_ID: tgChatId }),
      })
    } catch (_) {}
    finally { setTgSaving(false) }
    // Refresh status
    fetch(`${base}/detection/telegram/status`).then(r => r.json()).then(setTgStatus).catch(() => {})
  }

  const testTelegram = async () => {
    setTgTesting(true)
    try {
      const r = await fetch(`${base}/detection/telegram/test`, { method: 'POST' })
      const d = await r.json()
      setTgStatus(d.ok ? { configured: true, bot: d.bot } : { configured: false, error: d.error })
    } catch (e: any) {
      setTgStatus({ configured: false, error: e.message })
    } finally { setTgTesting(false) }
  }

  const saveRecDir = async (path?: string) => {
    const dir = (path ?? recDir).trim()
    if (!dir) return
    setSavingDir(true)
    setSaveDirMsg(null)
    try {
      const r = await fetch(`${base}/recordings/dir?path=${encodeURIComponent(dir)}`, { method: 'POST' })
      const data = await r.json().catch(() => ({}))
      if (r.ok) {
        setSaveDirMsg(`Saved: ${data.dir ?? dir}`)
        setTimeout(() => setSaveDirMsg(null), 4000)
      } else {
        setSaveDirMsg(`Error: ${data.detail ?? 'save failed'}`)
      }
    } catch (e: any) {
      setSaveDirMsg(`Error: ${e.message}`)
    } finally { setSavingDir(false) }
  }

  const browseFolder = async () => {
    const ipc = (window as any).electronAPI
    if (ipc?.showOpenDialog) {
      const chosen = await ipc.showOpenDialog({
        title: 'Select Recordings Folder',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (chosen) {
        setRecDir(chosen)
        await saveRecDir(chosen)   // auto-save immediately
      }
    } else {
      const p = window.prompt('Enter folder path for recordings:', recDir)
      if (p) {
        setRecDir(p)
        await saveRecDir(p)
      }
    }
  }

  const addCamera = async () => {
    setAdding(true)
    try {
      const r = await fetch(`${base}/config/cameras`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, kind: 'mobile' }),
      })
      const cam = await r.json()
      setNewCam(cam)
      fetchCameras()
      onCamerasChanged()
    } catch (e) { console.error(e) }
    finally { setAdding(false) }
  }

  const removeCamera = async (id: string) => {
    await fetch(`${base}/config/cameras/${id}`, { method: 'DELETE' })
    setNewCam(prev => prev?.id === id ? null : prev)
    fetchCameras()
    onCamerasChanged()
  }

  const mobileUrl = (id: string) => `${_scheme}://${lanIp}:${port}/mobile/page?cam=${id}`

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(3px)',
        zIndex: 200,
      }} />

      {/* Panel */}
      <div style={{
        position: 'fixed', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 201,
        background: '#0f0f1a',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 16,
        padding: 28,
        width: 540, maxWidth: '95vw',
        maxHeight: '85vh',
        overflowY: 'auto',
        boxShadow: '0 32px 80px rgba(0,0,0,0.8)',
        fontFamily: "'Inter', sans-serif",
        color: '#f0f0ff',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 3 }}>Camera Settings</h2>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
              Connect mobile phones as IP cameras over LAN
            </p>
          </div>
          <button onClick={onClose} style={{
            background: 'rgba(255,255,255,0.07)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: 'rgba(255,255,255,0.6)',
            borderRadius: 8, width: 32, height: 32,
            cursor: 'pointer', fontSize: 16, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}>✕</button>
        </div>

        {/* Network info */}
        <section style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1, color: 'rgba(255,255,255,0.35)', marginBottom: 10, textTransform: 'uppercase' }}>
            Network
          </div>
          <div style={{
            background: 'rgba(124,111,255,0.08)',
            border: '1px solid rgba(124,111,255,0.2)',
            borderRadius: 10, padding: '12px 16px',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 2 }}>Your LAN IP</div>
                <div style={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 600, color: '#a89fff' }}>{lanIp}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 2 }}>Backend Port</div>
                <div style={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 600, color: '#a89fff' }}>{port}</div>
              </div>
              <div style={{ flex: 1, textAlign: 'right' }}>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 2 }}>Status</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5, fontSize: 12 }}>
                  <StatusDot ok={true} /> Online
                </div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', background: 'rgba(0,0,0,0.3)', borderRadius: 6, padding: '6px 10px', fontFamily: 'monospace' }}>
              📱 On phone browser: {_scheme}://{lanIp}:{port}/mobile/page?cam=&lt;id&gt;
              {_scheme === 'https' && <span style={{ color: '#fbbf24', marginLeft: 6, fontFamily: 'sans-serif' }}>⚠ Accept cert warning on first open</span>}
            </div>
          </div>
        </section>

        {/* Recordings Folder */}
        <section style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1, color: 'rgba(255,255,255,0.35)', marginBottom: 10, textTransform: 'uppercase' }}>
            Recordings Folder
          </div>
          <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 8 }}>
              Video recordings are saved here. Each camera stream is recorded automatically.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={recDir}
                onChange={e => setRecDir(e.target.value)}
                placeholder="e.g. C:\Users\...\recordings"
                style={{
                  flex: 1, background: 'rgba(255,255,255,0.07)',
                  border: '1px solid rgba(255,255,255,0.13)',
                  color: '#f0f0ff', borderRadius: 8, padding: '8px 12px',
                  fontSize: 12, outline: 'none', fontFamily: 'monospace',
                }}
              />
              <button onClick={browseFolder} style={{
                background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)',
                color: 'rgba(255,255,255,0.7)', borderRadius: 8, padding: '8px 14px',
                fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
              }}>📁 Browse</button>
              <button onClick={() => saveRecDir()} disabled={savingDir} style={{
                background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.35)',
                color: '#86efac', borderRadius: 8, padding: '8px 14px',
                fontSize: 12, cursor: savingDir ? 'default' : 'pointer', whiteSpace: 'nowrap',
              }}>{savingDir ? 'Saving…' : '✓ Save'}</button>
            </div>
            {saveDirMsg && (
              <div style={{
                marginTop: 8, padding: '6px 10px', borderRadius: 6, fontSize: 11,
                background: saveDirMsg.startsWith('Error') ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)',
                color: saveDirMsg.startsWith('Error') ? '#fca5a5' : '#86efac',
                border: `1px solid ${saveDirMsg.startsWith('Error') ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}`,
                fontFamily: 'monospace', wordBreak: 'break-all',
              }}>{saveDirMsg}</div>
            )}

          </div>
        </section>

        {/* Add camera */}
        <section style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1, color: 'rgba(255,255,255,0.35)', marginBottom: 10, textTransform: 'uppercase' }}>
            Add Mobile Camera
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Camera name"
              style={{
                flex: 1,
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(255,255,255,0.13)',
                borderRadius: 8, padding: '8px 12px',
                color: '#fff', fontSize: 13, outline: 'none',
                fontFamily: "'Inter', sans-serif",
              }}
            />
            <button
              onClick={addCamera}
              disabled={adding}
              style={{
                background: 'rgba(124,111,255,0.2)',
                border: '1px solid rgba(124,111,255,0.5)',
                color: '#a89fff', fontSize: 13, fontWeight: 600,
                padding: '8px 18px', borderRadius: 8, cursor: 'pointer',
                whiteSpace: 'nowrap', opacity: adding ? 0.6 : 1,
              }}
            >
              {adding ? 'Adding…' : '+ Add'}
            </button>
          </div>

          {/* Newly created cam URL */}
          {newCam && (
            <div style={{
              marginTop: 12,
              background: 'rgba(34,197,94,0.08)',
              border: '1px solid rgba(34,197,94,0.25)',
              borderRadius: 10, padding: '12px 14px',
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#86efac', marginBottom: 8 }}>
                ✓ Camera added — share this URL with your phone:
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <code style={{
                  flex: 1, fontSize: 11, color: 'rgba(255,255,255,0.7)',
                  background: 'rgba(0,0,0,0.35)', borderRadius: 6,
                  padding: '6px 10px', overflowX: 'auto',
                  fontFamily: 'monospace', whiteSpace: 'nowrap',
                  display: 'block',
                }}>
                  {mobileUrl(newCam.id)}
                </code>
                <CopyBtn text={mobileUrl(newCam.id)} />
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 6 }}>
                Open this URL on your phone's browser (same Wi-Fi network)
              </div>
            </div>
          )}
        </section>

        {/* Camera list */}
        <section>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1, color: 'rgba(255,255,255,0.35)', marginBottom: 10, textTransform: 'uppercase' }}>
            Connected Mobile Cameras ({cameras.length})
          </div>

          {cameras.length === 0 ? (
            <div style={{
              textAlign: 'center', padding: '32px 16px',
              color: 'rgba(255,255,255,0.25)', fontSize: 13,
              border: '1px dashed rgba(255,255,255,0.1)',
              borderRadius: 10,
            }}>
              No mobile cameras added yet.<br />
              <span style={{ fontSize: 11 }}>Add one above and open the URL on your phone.</span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cameras.map(cam => (
                <div key={cam.id} style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: `1px solid ${cam.connected ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.08)'}`,
                  borderRadius: 10, padding: '12px 14px',
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  {/* Status */}
                  <StatusDot ok={cam.connected} />

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{cam.name}</div>
                    <div style={{
                      fontSize: 10, fontFamily: 'monospace',
                      color: 'rgba(255,255,255,0.35)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      id: {cam.id} · {cam.connected ? '🟢 streaming' : '⚪ offline'}
                    </div>
                  </div>

                  {/* URL copy */}
                  <CopyBtn text={mobileUrl(cam.id)} />

                  {/* Remove */}
                  <button
                    onClick={() => removeCamera(cam.id)}
                    title="Remove camera"
                    style={{
                      background: 'rgba(239,68,68,0.1)',
                      border: '1px solid rgba(239,68,68,0.25)',
                      color: 'rgba(239,68,68,0.7)',
                      borderRadius: 6, width: 28, height: 28,
                      cursor: 'pointer', fontSize: 13,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Telegram Alerts ── */}
        <section style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1, color: 'rgba(255,255,255,0.35)', marginBottom: 10, textTransform: 'uppercase' }}>
            Telegram Threat Alerts
          </div>
          <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '12px 14px' }}>

            {/* Status badge */}
            {tgStatus && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
                padding: '6px 10px', borderRadius: 8,
                background: tgStatus.configured ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                border: `1px solid ${tgStatus.configured ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.2)'}`,
              }}>
                <span style={{ fontSize: 14 }}>{tgStatus.configured ? '✅' : '❌'}</span>
                <span style={{ fontSize: 12, color: tgStatus.configured ? '#86efac' : '#fca5a5' }}>
                  {tgStatus.configured ? `Connected — ${tgStatus.bot ?? ''}` : tgStatus.error ?? 'Not configured'}
                </span>
              </div>
            )}

            {/* Setup guide */}
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 10, lineHeight: 1.6 }}>
              <b style={{ color: 'rgba(255,255,255,0.6)' }}>Setup:</b><br />
              1️⃣ Open Telegram → search <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>@BotFather</code> → send <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>/newbot</code> → copy the token<br />
              2️⃣ Send any message to your bot, then open{' '}
              <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3, wordBreak: 'break-all' }}>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code>{' '}
              and copy the <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3 }}>"id"</code> field from the result<br />
              3️⃣ Paste both below and click ✨ Save &amp; Test
            </div>

            {/* Token input */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginBottom: 4 }}>Bot Token</div>
              <input
                value={tgToken}
                onChange={e => setTgToken(e.target.value)}
                placeholder="123456789:ABCDEFghijklmnopqrstuvwxyz"
                type="password"
                style={{
                  width: '100%', boxSizing: 'border-box',
                  background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.13)',
                  color: '#f0f0ff', borderRadius: 8, padding: '8px 12px',
                  fontSize: 12, outline: 'none', fontFamily: 'monospace',
                }}
              />
            </div>

            {/* Chat ID input */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginBottom: 4 }}>Chat ID</div>
              <input
                value={tgChatId}
                onChange={e => setTgChatId(e.target.value)}
                placeholder="-100123456789 or 123456789"
                style={{
                  width: '100%', boxSizing: 'border-box',
                  background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.13)',
                  color: '#f0f0ff', borderRadius: 8, padding: '8px 12px',
                  fontSize: 12, outline: 'none', fontFamily: 'monospace',
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={saveTelegram} disabled={tgSaving || !tgToken || !tgChatId} style={{
                flex: 1, background: 'rgba(124,111,255,0.15)', border: '1px solid rgba(124,111,255,0.35)',
                color: '#c4bcff', borderRadius: 8, padding: '8px 0',
                fontSize: 12, cursor: (tgSaving || !tgToken || !tgChatId) ? 'default' : 'pointer',
                opacity: (!tgToken || !tgChatId) ? 0.5 : 1,
              }}>{tgSaving ? 'Saving…' : '💾 Save'}</button>
              <button onClick={testTelegram} disabled={tgTesting} style={{
                flex: 1, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)',
                color: '#86efac', borderRadius: 8, padding: '8px 0',
                fontSize: 12, cursor: tgTesting ? 'default' : 'pointer',
              }}>{tgTesting ? 'Sending…' : '✨ Test Alert'}</button>
            </div>
          </div>
        </section>

      </div>
    </>
  )
}
