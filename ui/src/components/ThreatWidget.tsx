import { useState, useEffect, useRef, useCallback } from "react"

interface PersonDet {
  pid: string
  class: string
  conf: number
  activity: string
  threat_score: number
  bbox: [number, number, number, number]
}

interface DetectionEvent {
  cam_id: string
  ts: number
  fps: number
  persons: PersonDet[]
  max_threat: number
  alert: boolean
  person_count: number
}

interface Props {
  base: string
  camIds: string[]    // list of active camera IDs to subscribe to
}

function ThreatBar({ score }: { score: number }) {
  const pct = Math.round(score * 100)
  const col = score >= 0.7 ? "#ef4444" : score >= 0.5 ? "#f97316" : score >= 0.3 ? "#eab308" : "#22c55e"
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, height: 5, background: "rgba(255,255,255,0.08)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: col, borderRadius: 3, transition: "width 0.3s, background 0.3s" }} />
      </div>
      <span style={{ fontSize: 10, fontWeight: 700, color: col, minWidth: 30 }}>{pct}%</span>
    </div>
  )
}

function ActivityIcon({ activity }: { activity: string }) {
  const icons: Record<string, string> = {
    "standing": "🧍", "running": "🏃", "crouching": "🫱",
    "lying down": "🩺", "hands raised": "🙌", "bent over": "🙇",
    "unknown": "❓",
  }
  return <span title={activity}>{icons[activity] ?? "👤"}</span>
}

export default function ThreatWidget({ base, camIds }: Props) {
  const [events, setEvents]         = useState<Record<string, DetectionEvent>>({})
  const [minimized, setMinimized]   = useState(false)
  const [alerts, setAlerts]         = useState<string[]>([])
  const esRefs = useRef<Record<string, EventSource>>({})

  const subscribe = useCallback((camId: string) => {
    if (esRefs.current[camId]) return
    const es = new EventSource(`${base}/detection/events/${camId}`)
    es.onmessage = (e) => {
      try {
        const ev: DetectionEvent = JSON.parse(e.data)
        setEvents(prev => ({ ...prev, [camId]: ev }))
        if (ev.alert) {
          setAlerts(prev => {
            const msg = `⚠ ${camId}: ${ev.person_count} person(s) — threat ${Math.round(ev.max_threat*100)}%`
            return [msg, ...prev].slice(0, 5)
          })
        }
      } catch (_) {}
    }
    es.onerror = () => {}
    esRefs.current[camId] = es
  }, [base])

  useEffect(() => {
    camIds.forEach(subscribe)
    // Cleanup removed cams
    return () => {
      Object.entries(esRefs.current).forEach(([id, es]) => {
        if (!camIds.includes(id)) { es.close(); delete esRefs.current[id] }
      })
    }
  }, [camIds, subscribe])

  useEffect(() => {
    return () => { Object.values(esRefs.current).forEach(es => es.close()) }
  }, [])

  const allPersons = Object.values(events).flatMap(ev => ev.persons)
  const maxThreat  = Math.max(0, ...Object.values(events).map(ev => ev.max_threat))
  const anyAlert   = Object.values(events).some(ev => ev.alert)

  const threatColor = maxThreat >= 0.7 ? "#ef4444" : maxThreat >= 0.5 ? "#f97316" : maxThreat >= 0.3 ? "#eab308" : "#22c55e"

  return (
    <div style={{
      position: "fixed", bottom: 20, right: 20, zIndex: 150,
      width: minimized ? 160 : 340,
      background: "linear-gradient(145deg,#0a0a18,#0f0f22)",
      border: `1px solid ${anyAlert ? "rgba(239,68,68,0.5)" : "rgba(124,111,255,0.25)"}`,
      borderRadius: 16, overflow: "hidden",
      boxShadow: anyAlert
        ? "0 0 30px rgba(239,68,68,0.3), 0 16px 60px rgba(0,0,0,0.8)"
        : "0 16px 60px rgba(0,0,0,0.7)",
      fontFamily: "'Inter',sans-serif",
      transition: "width 0.3s, border-color 0.3s, box-shadow 0.3s",
    }}>

      {/* Header */}
      <div
        onClick={() => setMinimized(m => !m)}
        style={{
          padding: "10px 14px", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 8,
          borderBottom: minimized ? "none" : "1px solid rgba(255,255,255,0.07)",
          background: anyAlert ? "rgba(239,68,68,0.1)" : "transparent",
        }}
      >
        {anyAlert && <span style={{ animation: "livepulse 1s ease-in-out infinite", fontSize: 14 }}>🚨</span>}
        {!anyAlert && <span style={{ fontSize: 14 }}>🛡</span>}
        <span style={{ flex: 1, fontSize: 12, fontWeight: 700, color: anyAlert ? "#fca5a5" : "#f0f0ff" }}>
          {minimized ? `Threat ${Math.round(maxThreat*100)}%` : "Threat Intelligence"}
        </span>
        {!minimized && (
          <span style={{
            fontSize: 11, fontWeight: 700, color: threatColor,
            background: `${threatColor}22`, border: `1px solid ${threatColor}44`,
            borderRadius: 8, padding: "2px 8px",
          }}>
            {Math.round(maxThreat * 100)}%
          </span>
        )}
        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>{minimized ? "▲" : "▼"}</span>
      </div>

      {!minimized && (
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Global threat meter */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.35)", letterSpacing: 1, textTransform: "uppercase", marginBottom: 5 }}>
              Overall Threat Level
            </div>
            <ThreatBar score={maxThreat} />
          </div>

          {/* Alerts */}
          {alerts.length > 0 && (
            <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, padding: "8px 10px" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#fca5a5", marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.8 }}>Recent Alerts</div>
              {alerts.slice(0, 3).map((a, i) => (
                <div key={i} style={{ fontSize: 11, color: "#fca5a5", lineHeight: 1.5, opacity: i === 0 ? 1 : 0.5 + i*0.1 }}>{a}</div>
              ))}
            </div>
          )}

          {/* Per-camera stats */}
          {Object.entries(events).map(([camId, ev]) => (
            <div key={camId} style={{ background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "#a89fff" }}>📷 {camId.slice(0,10)}</span>
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>{ev.fps} FPS · {ev.person_count} person(s)</span>
              </div>
              <ThreatBar score={ev.max_threat} />
            </div>
          ))}

          {/* Persons table */}
          {allPersons.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.35)", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>
                Tracked Persons
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {allPersons.map((p, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    background: p.threat_score >= 0.6 ? "rgba(239,68,68,0.08)" : "rgba(255,255,255,0.04)",
                    borderRadius: 8, padding: "7px 10px",
                    border: p.threat_score >= 0.6 ? "1px solid rgba(239,68,68,0.2)" : "1px solid transparent",
                  }}>
                    <ActivityIcon activity={p.activity} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "#f0f0ff" }}>{p.pid}</span>
                        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{p.class}</span>
                      </div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", marginTop: 1 }}>{p.activity}</div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: p.threat_score >= 0.6 ? "#ef4444" : p.threat_score >= 0.4 ? "#f97316" : "#22c55e" }}>
                        {Math.round(p.threat_score * 100)}%
                      </div>
                      <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>{Math.round(p.conf*100)}% conf</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {allPersons.length === 0 && Object.keys(events).length > 0 && (
            <div style={{ textAlign: "center", padding: "8px 0", color: "rgba(255,255,255,0.2)", fontSize: 12 }}>
              🔍 No persons detected
            </div>
          )}

          {Object.keys(events).length === 0 && (
            <div style={{ textAlign: "center", padding: "8px 0", color: "rgba(255,255,255,0.2)", fontSize: 12 }}>
              Waiting for cameras…
            </div>
          )}
        </div>
      )}
    </div>
  )
}
