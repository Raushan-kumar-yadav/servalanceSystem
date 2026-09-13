import { useState, useRef, useCallback, useEffect } from "react"

interface Hit {
  recordingId: string
  cam_id: string
  date: string
  start_sec: number
  end_sec: number
  text: string
  score: number
}

interface Props {
  base: string
  onClose: () => void
}

function fmtSec(s: number) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, "0")}`
}

function ScoreBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  const col = score > 0.75 ? "#22c55e" : score > 0.5 ? "#eab308" : "#f97316"
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: "2px 7px",
      borderRadius: 10, background: `${col}22`, color: col,
      border: `1px solid ${col}44`, letterSpacing: 0.5,
    }}>
      {pct}%
    </span>
  )
}

export default function SearchClipsPanel({ base, onClose }: Props) {
  const [query,       setQuery]       = useState("")
  const [loading,     setLoading]     = useState(false)
  const [hits,        setHits]        = useState<Hit[]>([])
  const [searched,    setSearched]    = useState(false)
  const [error,       setError]       = useState("")
  const [activeHit,   setActiveHit]   = useState<Hit | null>(null)
  const [indexStatus, setIndexStatus] = useState<Record<string, string>>({})
  const [indexing,    setIndexing]    = useState(false)
  const [queueLen,    setQueueLen]    = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const poll = () => {
      fetch(`${base}/recordings/index-status`)
        .then(r => r.json())
        .then(d => { setIndexStatus(d.status ?? {}); setQueueLen(d.queue_len ?? 0) })
        .catch(() => {})
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => clearInterval(t)
  }, [base])

  const search = useCallback(async () => {
    if (!query.trim()) return
    setLoading(true); setError(""); setHits([])
    try {
      const r = await fetch(`${base}/recordings/search?query=${encodeURIComponent(query)}&top_k=10`, { method: "POST" })
      const d = await r.json()
      setHits(d.hits ?? [])
      setSearched(true)
      if (d.error) setError(d.error)
    } catch (e: any) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [base, query])

  const indexAll = async () => {
    setIndexing(true)
    try {
      await fetch(`${base}/recordings/index-all`, { method: "POST" })
    } finally {
      setTimeout(() => setIndexing(false), 1500)
    }
  }

  const playHit = (hit: Hit) => {
    setActiveHit(hit)
    setTimeout(() => {
      if (videoRef.current) {
        videoRef.current.currentTime = hit.start_sec
        videoRef.current.play().catch(() => {})
      }
    }, 150)
  }

  const totalRecordings = Object.keys(indexStatus).length
  const indexedCount    = Object.values(indexStatus).filter(s => s === "indexed").length

  const QUICK = ["person near fence","vehicle at night","group gathering","running person","unusual movement"]

  return (
    <>
      <div onClick={onClose} style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",backdropFilter:"blur(4px)",zIndex:300 }} />
      <div style={{
        position:"fixed",top:"50%",left:"50%",transform:"translate(-50%,-50%)",
        zIndex:301,width:840,maxWidth:"96vw",maxHeight:"88vh",
        background:"linear-gradient(145deg,#0c0c1a 0%,#0f0f22 100%)",
        border:"1px solid rgba(124,111,255,0.25)",borderRadius:20,
        display:"flex",flexDirection:"column",
        boxShadow:"0 40px 120px rgba(0,0,0,0.9)",overflow:"hidden",
        fontFamily:"'Inter',sans-serif",color:"#f0f0ff",
      }}>

        {/* Header */}
        <div style={{ padding:"18px 24px 14px",borderBottom:"1px solid rgba(255,255,255,0.07)",display:"flex",alignItems:"center",gap:12,flexShrink:0 }}>
          <span style={{ fontSize:20 }}>🔍</span>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:16,fontWeight:700 }}>Search Footage</div>
            <div style={{ fontSize:11,color:"rgba(255,255,255,0.35)",marginTop:1 }}>Natural language search across indexed recordings</div>
          </div>
          <div style={{ fontSize:11,color:"rgba(255,255,255,0.4)",background:"rgba(255,255,255,0.05)",borderRadius:8,padding:"5px 12px",display:"flex",alignItems:"center",gap:8 }}>
            <span style={{ color:indexedCount>0?"#22c55e":"rgba(255,255,255,0.3)" }}>●</span>
            {indexedCount}/{totalRecordings} indexed
            {queueLen>0 && <span style={{ color:"#eab308" }}>· {queueLen} running</span>}
          </div>
          <button onClick={indexAll} disabled={indexing} style={{ background:indexing?"rgba(124,111,255,0.1)":"rgba(124,111,255,0.18)",border:"1px solid rgba(124,111,255,0.35)",color:"#a89fff",borderRadius:8,padding:"6px 14px",fontSize:12,fontWeight:600,cursor:indexing?"default":"pointer" }}>
            {indexing ? "⏳ Indexing…" : "⚡ Index All"}
          </button>
          <button onClick={onClose} style={{ background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",color:"rgba(255,255,255,0.5)",borderRadius:8,width:30,height:30,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center" }}>✕</button>
        </div>

        {/* Search bar */}
        <div style={{ padding:"16px 24px 12px",flexShrink:0 }}>
          <div style={{ display:"flex",gap:10 }}>
            <input
              value={query} onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key==="Enter" && search()}
              placeholder={`"person climbing fence", "vehicle at night", "suspicious activity"...`}
              autoFocus
              style={{ flex:1,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(124,111,255,0.35)",color:"#f0f0ff",borderRadius:10,padding:"10px 16px",fontSize:14,outline:"none",fontFamily:"'Inter',sans-serif" }}
            />
            <button onClick={search} disabled={loading||!query.trim()} style={{ background:"linear-gradient(135deg,#7c6fff,#a78bfa)",border:"none",color:"#fff",borderRadius:10,padding:"10px 22px",fontSize:14,fontWeight:700,cursor:loading||!query.trim()?"default":"pointer",opacity:loading||!query.trim()?0.5:1 }}>
              {loading ? "…" : "Search"}
            </button>
          </div>
          <div style={{ display:"flex",gap:6,marginTop:8,flexWrap:"wrap" }}>
            {QUICK.map(p => (
              <button key={p} onClick={() => setQuery(p)} style={{ background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",color:"rgba(255,255,255,0.5)",borderRadius:20,padding:"3px 12px",fontSize:11,cursor:"pointer" }}>{p}</button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex:1,display:"flex",overflow:"hidden" }}>

          {/* Results */}
          <div style={{ width:activeHit?320:"100%",flexShrink:0,overflowY:"auto",borderRight:activeHit?"1px solid rgba(255,255,255,0.07)":"none",paddingBottom:16 }}>
            {error && <div style={{ margin:"12px 24px",padding:"10px 14px",background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:8,fontSize:12,color:"#fca5a5" }}>⚠ {error}</div>}

            {!searched && !loading && (
              <div style={{ textAlign:"center",color:"rgba(255,255,255,0.2)",padding:"48px 24px",fontSize:14 }}>
                <div style={{ fontSize:40,marginBottom:12 }}>🎞</div>
                <div>Describe what you are looking for in English</div>
                <div style={{ fontSize:12,marginTop:8,color:"rgba(255,255,255,0.15)" }}>Use ⚡ Index All to index recordings first</div>
              </div>
            )}

            {loading && <div style={{ textAlign:"center",padding:"48px 24px",color:"rgba(255,255,255,0.4)" }}><div style={{ fontSize:28,marginBottom:8 }}>🔍</div>Searching…</div>}

            {searched && !loading && hits.length===0 && !error && (
              <div style={{ textAlign:"center",padding:"48px 24px",color:"rgba(255,255,255,0.3)",fontSize:13 }}>
                <div style={{ fontSize:32,marginBottom:8 }}>🔇</div>No matching clips found
                <div style={{ fontSize:11,marginTop:6 }}>Try different words or index more recordings</div>
              </div>
            )}

            {hits.map((hit, i) => (
              <div key={i} onClick={() => playHit(hit)} style={{
                padding:"12px 20px",cursor:"pointer",
                borderBottom:"1px solid rgba(255,255,255,0.05)",
                background:activeHit===hit?"rgba(124,111,255,0.12)":"transparent",
                borderLeft:activeHit===hit?"3px solid #7c6fff":"3px solid transparent",
                transition:"background 0.15s",
              }}>
                <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:6 }}>
                  <ScoreBadge score={hit.score} />
                  <span style={{ fontSize:11,color:"rgba(255,255,255,0.35)",fontFamily:"monospace" }}>{fmtSec(hit.start_sec)} – {fmtSec(hit.end_sec)}</span>
                  <span style={{ fontSize:10,color:"rgba(255,255,255,0.25)",marginLeft:"auto" }}>📷 {hit.cam_id}</span>
                </div>
                <div style={{ fontSize:12,color:"rgba(255,255,255,0.75)",lineHeight:1.5,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden" }}>{hit.text}</div>
                <div style={{ fontSize:10,color:"rgba(255,255,255,0.2)",marginTop:4 }}>{hit.recordingId}.mp4</div>
              </div>
            ))}
          </div>

          {/* Video player */}
          {activeHit && (
            <div style={{ flex:1,display:"flex",flexDirection:"column",padding:"16px 20px",overflow:"hidden" }}>
              <div style={{ fontSize:12,color:"rgba(255,255,255,0.4)",marginBottom:10,fontFamily:"monospace" }}>
                🎬 {activeHit.recordingId}.mp4 · {fmtSec(activeHit.start_sec)} → {fmtSec(activeHit.end_sec)}
              </div>
              <video
                ref={videoRef}
                src={`${base}/recordings/serve/${activeHit.recordingId}.mp4`}
                controls
                style={{ width:"100%",borderRadius:12,background:"#000",maxHeight:300,border:"1px solid rgba(255,255,255,0.1)" }}
                onLoadedMetadata={() => { if(videoRef.current) videoRef.current.currentTime = activeHit.start_sec }}
              />
              <div style={{ marginTop:12,background:"rgba(255,255,255,0.04)",borderRadius:10,padding:"12px 14px",fontSize:12,color:"rgba(255,255,255,0.6)",lineHeight:1.6 }}>
                {activeHit.text}
              </div>
              <div style={{ fontSize:11,color:"rgba(255,255,255,0.3)",marginTop:8 }}>
                📅 {activeHit.date} · 📷 {activeHit.cam_id} · Match: {Math.round(activeHit.score*100)}%
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
