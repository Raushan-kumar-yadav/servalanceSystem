import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import SettingsWindow from './components/SettingsWindow'
import FloatingAIChat from './components/FloatingAIChat'
import SearchClipsPanel from './components/SearchClipsPanel'
import ThreatWidget from './components/ThreatWidget'
import TrackingVisualizer from './components/TrackingVisualizer'
import './App.css'

// ─────────────────────────── Types ───────────────────────────────────────────
interface CamEntry   { id: string; name: string; kind: 'mobile' | 'local'; connected?: boolean }
interface VpEntry    { id: string; title: string; cam_id: string | null; inference: number }

// ─────────────────────────── Tiny helpers ────────────────────────────────────
function StatusDot({ ok, color }: { ok: boolean; color?: string }) {
  const c = ok ? (color ?? '#22c55e') : '#ef4444'
  return <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%', background:c, boxShadow:`0 0 7px ${c}99`, flexShrink:0 }} />
}

function LiveBadge({ label = 'LIVE' }: { label?: string }) {
  return (
    <div style={{ position:'absolute', top:10, left:10, background:'rgba(220,38,38,0.88)', backdropFilter:'blur(4px)', borderRadius:4, padding:'3px 8px', fontSize:10, fontWeight:700, color:'#fff', letterSpacing:1.2, display:'flex', alignItems:'center', gap:4, zIndex:20 }}>
      <span style={{ width:5, height:5, borderRadius:'50%', background:'#fff', animation:'livepulse 1.2s ease-in-out infinite' }} />
      {label}
    </div>
  )
}

// ─────────────────────────── Local camera feed (getUserMedia + inference) ─────
function LocalFeed({ deviceId, port, scheme, doInfer }: { deviceId: string; port: number; scheme: string; doInfer: boolean }) {
  const videoRef  = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const outputRef = useRef<HTMLImageElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const loopRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fpsRef    = useRef({ count: 0, last: Date.now() })

  const [fps, setFps]             = useState(0)
  const [ms, setMs]               = useState(0)
  const [persons, setPersons]     = useState(0)
  const [modelReady, setModelReady] = useState(false)
  const [live, setLive]           = useState(false)
  const [err, setErr]             = useState<string | null>(null)

  useEffect(() => {
    if (!deviceId) return
    setLive(false); setErr(null)

    let cancelled = false

    // Stop previous stream first
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
  
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.srcObject = null
    }

    if (!navigator.mediaDevices?.getUserMedia) { setErr('Camera API unavailable'); return }

    navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    }).then(stream => {
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
      
        videoRef.current.play().catch(e => {
          if (e.name !== 'AbortError') setErr(e.message ?? 'Play error')
        })
      }
      setLive(true)
    }).catch(e => { if (!cancelled) setErr(e.message ?? 'Camera error') })

    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
  }, [deviceId])

  useEffect(() => {
    if (!port) return
    const base = `${scheme}://127.0.0.1:${port}`
    const poll = async () => {
      try {
        const r = await fetch(`${base}/inference/status`)
        const j = await r.json()
        setModelReady(j.loaded)
        if (!j.loaded) {
          fetch(`${base}/inference/load`, { method: 'POST' }).catch(() => {})
          setTimeout(poll, 2000)
        }
      } catch { setTimeout(poll, 3000) }
    }
    poll()
  }, [port, scheme])

  const runInference = useCallback(async () => {
    const video = videoRef.current, canvas = canvasRef.current, output = outputRef.current
    if (!video || !canvas || !output || !modelReady || video.readyState < 2) return
    const ctx = canvas.getContext('2d')!
    canvas.width = video.videoWidth || 640; canvas.height = video.videoHeight || 480
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob: Blob = await new Promise(r => canvas.toBlob(b => r(b!), 'image/jpeg', 0.8))
    const form = new FormData(); form.append('file', blob, 'frame.jpg')
    const t0 = performance.now()
    // Use the full detection pipeline (ReID + events + benchmarking) instead of /inference/pose
    const camId = `local_${deviceId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'cam'}`
    try {
      const resp = await fetch(`${scheme}://127.0.0.1:${port}/detection/frame/${camId}`, { method:'POST', body:form })
      if (!resp.ok) return
      // Parse detection event for benchmarking stats
      const evtHeader = resp.headers.get('X-Detection-Event')
      if (evtHeader) {
        try {
          const ev = JSON.parse(evtHeader)
          if (typeof ev.person_count === 'number') setPersons(ev.person_count)
        } catch {}
      }
      const imgBlob = await resp.blob()
      const url = URL.createObjectURL(imgBlob)
      const prev = output.src
      output.src = url
      if (prev.startsWith('blob:')) URL.revokeObjectURL(prev)
      fpsRef.current.count++
      const now = performance.now()
      if (now - fpsRef.current.last >= 1000) {
        setFps(fpsRef.current.count); fpsRef.current = { count: 0, last: now }
      }
      setMs(Math.round(now - t0))
    } catch {}
  }, [port, scheme, modelReady, deviceId])


  useEffect(() => {
    if (!doInfer || !live || !modelReady) return
    const loop = () => { runInference().finally(() => { loopRef.current = setTimeout(loop, 80) }) }
    loop()
    return () => { if (loopRef.current) clearTimeout(loopRef.current) }
  }, [doInfer, live, modelReady, runInference])

  return (
    <div style={{ position:'relative', width:'100%', height:'100%', background:'#000', overflow:'hidden' }}>
      <video ref={videoRef} autoPlay playsInline muted style={{ display:'none' }} />
      <canvas ref={canvasRef} style={{ display:'none' }} />
      {doInfer && modelReady
        ? <img ref={outputRef} alt="" style={{ width:'100%', height:'100%', objectFit:'contain', display:'block' }} />
        : <video autoPlay playsInline muted
            ref={v => { if (v && streamRef.current) { v.srcObject = streamRef.current; v.play() } }}
            style={{ width:'100%', height:'100%', objectFit:'contain', display:'block' }} />
      }
      {err && (
        <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:8, color:'rgba(255,255,255,0.35)' }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.9L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
          <span style={{ fontSize:11 }}>{err}</span>
        </div>
      )}
      {live && <LiveBadge label={doInfer ? 'LIVE · POSE' : 'LIVE'} />}
      {live && doInfer && modelReady && (
        <div style={{ position:'absolute', bottom:8, right:8, display:'flex', gap:5, zIndex:20 }}>
          {[`${fps}fps`, `${ms}ms`].map(t => (
            <div key={t} className="stat-chip" style={{ padding:'3px 8px' }}>
              <span className="stat-val" style={{ fontSize:13 }}>{t}</span>
            </div>
          ))}
        </div>
      )}
      {live && !modelReady && doInfer && (
        <div style={{ position:'absolute', bottom:8, left:'50%', transform:'translateX(-50%)', display:'flex', alignItems:'center', gap:6, background:'rgba(0,0,0,0.6)', borderRadius:8, padding:'4px 12px', fontSize:11, color:'rgba(255,255,255,0.5)', zIndex:20 }}>
          <div style={{ width:12, height:12, border:'2px solid rgba(255,255,255,0.2)', borderTopColor:'#7c6fff', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
          Loading model…
        </div>
      )}
    </div>
  )
}

// ─────────────────────────── Mobile camera feed (MJPEG + optional detection) ──
function MobileFeed({ camId, port, scheme, connected, doDetect }: {
  camId: string; port: number; scheme: string; connected: boolean; doDetect: boolean
}) {
  const base    = `${scheme}://127.0.0.1:${port}`
  const rawSrc  = `${base}/mobile/stream/${camId}`
  const imgRef  = useRef<HTMLImageElement>(null)
  const canvRef = useRef<HTMLCanvasElement>(null)
  const timerRef= useRef<ReturnType<typeof setInterval> | null>(null)

  // When detection is ON, poll raw MJPEG → grab frame → POST → show annotated
  useEffect(() => {
    if (!doDetect || !connected) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      return
    }
    const img = new Image(); img.crossOrigin = 'anonymous'
    img.src = rawSrc
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!

    let running = true
    let lastFingerprint = ''   // pixel hash to detect new frames
    let inFlight = false       // prevent concurrent requests

    const tick = async () => {
      if (!running || inFlight) return
      if (!img.complete || img.naturalWidth === 0) return

      canvas.width  = img.naturalWidth
      canvas.height = img.naturalHeight
      ctx.drawImage(img, 0, 0)

      // Fast fingerprint: sample 16 pixels across the frame
      const w = canvas.width, h = canvas.height
      let fp = ''
      for (let i = 0; i < 16; i++) {
        const d = ctx.getImageData(Math.floor(w * i / 16), Math.floor(h / 2), 1, 1).data
        fp += d[0].toString(16) + d[1].toString(16) + d[2].toString(16)
      }
      if (fp === lastFingerprint) return   // same frame, skip POST
      lastFingerprint = fp

      const blob: Blob | null = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.8))
      if (!blob || !running) return

      inFlight = true
      const form = new FormData(); form.append('file', blob, 'frame.jpg')
      try {
        const r = await fetch(`${base}/detection/frame/${camId}`, { method: 'POST', body: form })
        if (r.ok && running) {
          const ab = await r.arrayBuffer()
          const url = URL.createObjectURL(new Blob([ab], { type: 'image/jpeg' }))
          if (imgRef.current) {
            const old = imgRef.current.src
            imgRef.current.src = url
            setTimeout(() => URL.revokeObjectURL(old), 500)
          }
        }
      } catch (_) {}
      inFlight = false
    }

    // Sequential timer: check every 200ms but only sends when frame actually changed
    timerRef.current = setInterval(tick, 200)
    return () => {
      running = false
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [doDetect, connected, camId, base, rawSrc])


  return (
    <div style={{ position:'relative', width:'100%', height:'100%', background:'#000' }}>
      {connected
        ? doDetect
          ? <img ref={imgRef} src={rawSrc} alt="detection" style={{ width:'100%', height:'100%', objectFit:'contain', display:'block' }} />
          : <img src={rawSrc} alt="mobile" style={{ width:'100%', height:'100%', objectFit:'contain', display:'block' }} />
        : <div style={{ width:'100%', height:'100%', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:8, color:'rgba(255,255,255,0.25)' }}>
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
            <span style={{ fontSize:12 }}>Waiting for phone…</span>
          </div>
      }
      {connected && <LiveBadge label={doDetect ? 'LIVE · DETECT' : 'LIVE · MOBILE'} />}
    </div>
  )
}

// ─────────────────────────── Single Viewport Tile ────────────────────────────
function ViewportTile({
  vp, cameras, localCams, port, scheme,
  onRemove, onCamChange, onInferChange,
}: {
  vp: VpEntry
  cameras: CamEntry[]
  localCams: { deviceId: string; label: string }[]
  port: number
  scheme: string
  onRemove: () => void
  onCamChange: (camKey: string) => void
  onInferChange: (v: number) => void
}) {
  const allOptions = [
    ...localCams.map(c => ({ key: `local:${c.deviceId}`, label: `💻 ${c.label}`, connected: true })),
    ...cameras.filter(c => c.kind === 'mobile').map(c => ({ key: `mobile:${c.id}`, label: `📱 ${c.name}${c.connected ? ' ●' : ' ○'}`, connected: !!c.connected })),
  ]

  const selKey = vp.cam_id ?? ''
  const selCam = allOptions.find(o => o.key === selKey)

  const feedEl = (() => {
    if (!selKey) return (
      <div style={{ width:'100%', height:'100%', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:8, color:'rgba(255,255,255,0.2)' }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.9L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/></svg>
        <span style={{ fontSize:12 }}>Select a camera</span>
      </div>
    )
    if (selKey.startsWith('local:')) {
      const devId = selKey.slice(6)
      return <LocalFeed deviceId={devId} port={port} scheme={scheme} doInfer={!!vp.inference} />
    }
    if (selKey.startsWith('mobile:')) {
      const camId = selKey.slice(7)
      const cam = cameras.find(c => c.id === camId)
      return <MobileFeed camId={camId} port={port} scheme={scheme} connected={cam?.connected ?? false} doDetect={!!vp.inference} />
    }
    return null
  })()

  return (
    <div style={{ position:'relative', display:'flex', flexDirection:'column', background:'#0a0a16', border:'1px solid rgba(255,255,255,0.07)', borderRadius:8, overflow:'hidden', minHeight:0 }}>
      {/* Tile Header */}
      <div style={{ display:'flex', alignItems:'center', gap:6, padding:'5px 8px', background:'rgba(0,0,0,0.55)', backdropFilter:'blur(4px)', borderBottom:'1px solid rgba(255,255,255,0.06)', flexShrink:0, zIndex:30 }}>
        <span style={{ fontSize:11, color:'rgba(255,255,255,0.4)', fontWeight:600, whiteSpace:'nowrap', minWidth:60 }}>{vp.title}</span>

        {/* Camera selector */}
        <select
          value={selKey}
          onChange={e => onCamChange(e.target.value)}
          className="ss-select"
          style={{ flex:1, minWidth:0, fontSize:11, padding:'3px 24px 3px 8px', height:24 }}
        >
          <option value="" style={{ background:'#13132a' }}>— Select camera —</option>
          {allOptions.map(o => (
            <option key={o.key} value={o.key} style={{ background:'#13132a', color:'#fff' }}>{o.label}</option>
          ))}
        </select>

        {/* Inference / Detection toggle */}
        {selKey && (
          <button
            onClick={() => onInferChange(vp.inference ? 0 : 1)}
            title="Toggle threat detection"
            style={{
              background: vp.inference ? 'rgba(239,68,68,0.18)' : 'rgba(255,255,255,0.06)',
              border: `1px solid ${vp.inference ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.1)'}`,
              color: vp.inference ? '#fca5a5' : 'rgba(255,255,255,0.4)',
              fontSize:10, borderRadius:5, padding:'2px 7px', cursor:'pointer', whiteSpace:'nowrap',
            }}
          >
            {vp.inference ? '🎯 DETECT ON' : '🎯 DETECT'}
          </button>
        )}

        {/* Remove tile */}
        <button
          onClick={onRemove}
          title="Remove viewport"
          style={{ background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.2)', color:'rgba(239,68,68,0.6)', borderRadius:5, width:22, height:22, cursor:'pointer', fontSize:11, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}
        >✕</button>
      </div>

      {/* Feed area */}
      <div style={{ flex:1, minHeight:0, position:'relative' }}>{feedEl}</div>
    </div>
  )
}

// ─────────────────────────── App ─────────────────────────────────────────────
export default function App() {
  const port   = (window as any).__FADE_PORT__   ?? 8000
  const scheme = (window as any).__FADE_SCHEME__ ?? 'http'
  const base   = `${scheme}://127.0.0.1:${port}`

  const [cameras, setCameras]       = useState<CamEntry[]>([])
  const [viewports, setViewports]   = useState<VpEntry[]>([])
  const [localCams, setLocalCams]   = useState<{ deviceId: string; label: string }[]>([])
  const [backendOk, setBackendOk]   = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showViz,      setShowViz]      = useState(false)

  // Stable camIds array — only changes when actual camera IDs change
  const vizCamIds = useMemo(
    () => viewports
      .filter(v => v.cam_id?.startsWith('mobile:') && v.inference)
      .map(v => v.cam_id!.slice(7)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewports.map(v => v.cam_id + v.inference).join(',')]
  )
  const [showAI,       setShowAI]       = useState(false)
  const [showSearch,   setShowSearch]   = useState(false)
  const [recording,    setRecording]    = useState<Record<string, boolean>>({})
  const [lanIp, setLanIp]           = useState('...')
  const [time, setTime]             = useState(new Date())


  useEffect(() => { const t = setInterval(() => setTime(new Date()), 1000); return () => clearInterval(t) }, [])

  // ── Backend health ──────────────────────────────────────────────────────────
  useEffect(() => {
    const check = async () => {
      try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }); setBackendOk(r.ok) }
      catch { setBackendOk(false) }
    }
    check(); const t = setInterval(check, 3000); return () => clearInterval(t)
  }, [base])

  // ── LAN IP ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!backendOk) return
    fetch(`${base}/mobile/lan-ip`).then(r => r.json()).then(d => setLanIp(d.ip)).catch(() => {})
  }, [base, backendOk])

  // ── Load cameras from DB ────────────────────────────────────────────────────
  const fetchCameras = useCallback(() => {
    fetch(`${base}/config/cameras`).then(r => r.json()).then(setCameras).catch(() => {})
  }, [base])

  useEffect(() => {
    if (!backendOk) return
    fetchCameras(); const t = setInterval(fetchCameras, 3000); return () => clearInterval(t)
  }, [backendOk, fetchCameras])

  // ── Load viewports from DB ──────────────────────────────────────────────────
  const fetchViewports = useCallback(() => {
    fetch(`${base}/config/viewports`).then(r => r.json()).then(setViewports).catch(() => {})
  }, [base])

  useEffect(() => {
    if (!backendOk) return
    fetchViewports()
  }, [backendOk, fetchViewports])

  // ── Local cameras (getUserMedia) ────────────────────────────────────────────
  const scanLocal = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) return
    try {
      await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      const devices = await navigator.mediaDevices.enumerateDevices()
      setLocalCams(devices.filter(d => d.kind === 'videoinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i}` })))
    } catch {}
  }, [])

  useEffect(() => {
    scanLocal()
    navigator.mediaDevices?.addEventListener('devicechange', scanLocal)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', scanLocal)
  }, [scanLocal])

  // ── Viewport actions ────────────────────────────────────────────────────────
  const addViewport = async () => {
    const title = `Viewport ${viewports.length + 1}`
    const r = await fetch(`${base}/config/viewports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    const vp = await r.json()
    setViewports(prev => [...prev, vp])
  }

  const removeViewport = async (id: string) => {
    await fetch(`${base}/config/viewports/${id}`, { method: 'DELETE' })
    setViewports(prev => prev.filter(v => v.id !== id))
  }

  const updateViewport = async (id: string, fields: Partial<VpEntry>) => {
    // Optimistic update
    setViewports(prev => prev.map(v => v.id === id ? { ...v, ...fields } : v))
    await fetch(`${base}/config/viewports/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).catch(() => {})
  }

  // ── Layout ──────────────────────────────────────────────────────────────────
  const count = viewports.length
  const cols  = count <= 1 ? 1 : count <= 4 ? 2 : 3
  const rows  = Math.ceil(count / cols)

  const fmtTime = time.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false })
  const fmtDate = time.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })

  const mobileCams = cameras.filter(c => c.kind === 'mobile')
  const connectedMobile = mobileCams.filter(c => c.connected).length

  return (
    <div className="app-shell">
      {/* ── Header ── */}
      <header className="ss-header">
        <div className="ss-header-left">
          <div className="ss-logo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7c6fff" strokeWidth="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            Surv<span className="ss-logo-accent">AI</span>llance
          </div>
          <div className="ss-chip"><StatusDot ok={backendOk} />{backendOk ? 'Online' : 'Connecting…'}</div>
          <div className="ss-chip">
            <StatusDot ok={localCams.length > 0} />
            {localCams.length} local · {mobileCams.length} mobile
            {connectedMobile > 0 && <span style={{ color:'#86efac', marginLeft:4 }}>({connectedMobile} live)</span>}
          </div>
        </div>

        <div className="ss-header-center">
          {/* Add viewport button */}
          <button id="add-viewport-btn" onClick={addViewport} className="ss-btn" style={{ gap:6 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Viewport
          </button>
          <div className="ss-chip" style={{ fontFamily:'monospace' }}>
            {count} viewport{count !== 1 ? 's' : ''} · {cols}×{rows} grid
          </div>
        </div>

        <div className="ss-header-right">
          {/* AI Chat button */}
          <button
            id="ai-chat-btn"
            onClick={() => setShowAI(v => !v)}
            className="ss-btn"
            title="AI Surveillance Analyst"
            style={showAI ? { background:'rgba(108,99,255,0.2)', borderColor:'rgba(108,99,255,0.5)', color:'#a78bfa' } : {}}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a10 10 0 0 1 10 10c0 5.52-4.48 10-10 10H2l2.29-2.29A9.96 9.96 0 0 1 2 12 10 10 0 0 1 12 2z"/>
              <path d="M8 10h.01M12 10h.01M16 10h.01"/>
            </svg>
            AI Analyst
          </button>
          <button
            id="tracking-viz-btn"
            onClick={() => setShowViz(v => !v)}
            className="ss-btn"
            title="3D Tracking Map"
            style={showViz ? { background:'rgba(124,111,255,0.15)', borderColor:'rgba(124,111,255,0.4)', color:'#a5b4fc' } : {}}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            3D Map
          </button>
          {/* Search Footage button */}
          <button
            id="search-clips-btn"
            onClick={() => setShowSearch(v => !v)}
            className="ss-btn"
            title="Search footage by description"
            style={showSearch ? { background:'rgba(34,197,94,0.15)', borderColor:'rgba(34,197,94,0.4)', color:'#86efac' } : {}}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            Search Clips
          </button>
          <button id="settings-btn" onClick={() => setShowSettings(true)} className="ss-btn" title="Camera settings" style={{ marginLeft:6 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
            Settings
          </button>
          <div className="ss-clock" style={{ marginLeft:12 }}>
            <div className="ss-clock-time">{fmtTime}</div>
            <div className="ss-clock-date">{fmtDate}</div>
          </div>
        </div>
      </header>

      {/* ── Viewport grid ── */}
      <main className="ss-viewport" style={{ padding:4, gap:4 }}>
        {count === 0 ? (
          <div className="ss-empty">
            <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1.2">
              <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
              <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
            </svg>
            <p style={{ marginTop:12 }}>No viewports yet</p>
            <button className="ss-btn" style={{ marginTop:8, gap:6 }} onClick={addViewport}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Add Viewport
            </button>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gridTemplateRows: `repeat(${rows}, 1fr)`,
            gap: 4,
            width: '100%',
            height: '100%',
          }}>
            {viewports.map(vp => (
              <ViewportTile
                key={vp.id}
                vp={vp}
                cameras={cameras}
                localCams={localCams}
                port={port}
                scheme={scheme}
                onRemove={() => removeViewport(vp.id)}
                onCamChange={camKey => updateViewport(vp.id, { cam_id: camKey })}
                onInferChange={v => updateViewport(vp.id, { inference: v })}
              />
            ))}
          </div>
        )}
      </main>

      {/* ── Footer ── */}
      <footer className="ss-footer">
        <span>AI Border Surveillance · YOLO11s-pose · RTX 3050</span>
        <span style={{ opacity:0.35 }}>{lanIp !== '...' ? `LAN: ${scheme}://${lanIp}:${port}` : `port:${port}`}</span>
      </footer>

      {/* ── Settings Window ── */}
      {showSettings && (
        <SettingsWindow
          port={port} lanIp={lanIp} scheme={scheme}
          onClose={() => setShowSettings(false)}
          onCamerasChanged={fetchCameras}
        />
      )}

      {/* -- AI Chat Panel -- */}
      {showAI && <FloatingAIChat onClose={() => setShowAI(false)} />}

      {/* -- 3D Tracking Visualizer -- */}
      {showViz && (
        <TrackingVisualizer
          base={`${scheme}://127.0.0.1:${port}`}
          camIds={vizCamIds}
          onClose={() => setShowViz(false)}
        />
      )}

      {/* ── Search Clips Panel ── */}
      {showSearch && (
        <SearchClipsPanel
          base={`${scheme}://127.0.0.1:${port}`}
          onClose={() => setShowSearch(false)}
        />
      )}

      {/* ── Threat Intelligence Widget (always visible when cams active) ── */}
      {cameras.filter(c => c.kind === 'mobile').length > 0 && (
        <ThreatWidget
          base={`${scheme}://127.0.0.1:${port}`}
          camIds={viewports
            .filter(v => v.cam_id?.startsWith('mobile:') && v.inference)
            .map(v => v.cam_id!.slice(7))}
        />
      )}

      <style>{`
        @keyframes livepulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.35;transform:scale(1.4)} }
        @keyframes spin { to{transform:rotate(360deg)} }
        .ss-viewport { display:flex; flex:1; min-height:0; overflow:hidden; }
      `}</style>
    </div>
  )
}
