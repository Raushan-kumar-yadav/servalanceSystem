/**
 * TrackingVisualizer.tsx
 * Fake-3D isometric tracking map showing person paths across all cameras.
 * - Pan: mouse drag
 * - Zoom: scroll wheel / pinch
 * - Person orbs with IDs + fading trail lines
 * - Camera zones as isometric floor tiles
 */
import { useEffect, useRef, useState, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PersonSnapshot {
  id:    string
  x:     number   // 0-1 normalised within camera zone
  y:     number   // 0-1
  ts:    number   // epoch ms
  threat: number  // 0-1
}

interface CamZone {
  cam_id: string
  label:  string
  col:    number  // grid column (isometric)
  row:    number  // grid row
  color:  string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ZONE_W  = 8   // cells per zone (width)
const ZONE_D  = 8   // cells per zone (depth)
const CELL_W  = 48  // pixel half-width of one isometric cell
const CELL_H  = 24  // pixel half-height
const TRAIL_MS = 30_000  // fade trail over 30 seconds
const MAX_TRAIL = 80     // max trail points per person

const ZONE_COLORS = [
  { fill: '#1e3a5f', stroke: '#3b82f6', glow: '#60a5fa' },
  { fill: '#1f2d1a', stroke: '#22c55e', glow: '#4ade80' },
  { fill: '#2d1a1a', stroke: '#ef4444', glow: '#f87171' },
  { fill: '#2a1f35', stroke: '#a855f7', glow: '#c084fc' },
  { fill: '#1a2a2d', stroke: '#06b6d4', glow: '#22d3ee' },
  { fill: '#2d2a1a', stroke: '#f59e0b', glow: '#fbbf24' },
]

// ── Isometric helpers ─────────────────────────────────────────────────────────

function isoProject(gx: number, gy: number): [number, number] {
  return [
    (gx - gy) * CELL_W,
    (gx + gy) * CELL_H,
  ]
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  base:   string
  camIds: string[]
  onClose: () => void
}

export default function TrackingVisualizer({ base, camIds, onClose }: Props) {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const animRef    = useRef<number>(0)

  // Camera zones — derived from camIds
  const [zones, setZones] = useState<CamZone[]>([])

  // Person trails: personKey -> list of snapshots
  const trailsRef = useRef<Map<string, PersonSnapshot[]>>(new Map())

  // View transform
  const viewRef = useRef({ x: 0, y: 0, scale: 1 })
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null)

  // Stats
  const [stats, setStats] = useState({ persons: 0, cameras: 0, alerts: 0 })

  // Build zones from camIds — only rebuild when IDs actually change
  const camIdsKey = camIds.join(',')
  useEffect(() => {
    const z: CamZone[] = camIds.map((id, i) => ({
      cam_id: id,
      label:  `CAM ${id.slice(0, 6).toUpperCase()}`,
      col:    (i % 3) * (ZONE_W + 2),
      row:    Math.floor(i / 3) * (ZONE_D + 2),
      color:  ZONE_COLORS[i % ZONE_COLORS.length].stroke,
    }))
    setZones(z)
    // NOTE: do NOT reset viewRef here — that would reset pan/zoom on every poll
  }, [camIdsKey])  // stable string key prevents spurious resets

  // SSE subscription per camera
  useEffect(() => {
    if (zones.length === 0) return
    const sources: EventSource[] = []

    zones.forEach(zone => {
      const es = new EventSource(`${base}/detection/events/${zone.cam_id}`)
      sources.push(es)

      es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data)
          if (!ev.persons) return
          const now = Date.now()

          ev.persons.forEach((p: any) => {
            const key = `${zone.cam_id}::${p.id ?? p.track_id ?? 'P?'}`
            const personId = p.id ?? p.track_id ?? 'P?'
            // bbox center normalised 0-1
            const bx = p.bbox ? (p.bbox[0] + p.bbox[2]) / 2 : 0.5
            const by = p.bbox ? (p.bbox[1] + p.bbox[3]) / 2 : 0.5

            const snap: PersonSnapshot = {
              id:     personId,
              x:      Math.max(0, Math.min(1, bx)),
              y:      Math.max(0, Math.min(1, by)),
              ts:     now,
              threat: p.threat_score ?? 0,
            }

            const trail = trailsRef.current.get(key) ?? []
            trail.push(snap)
            // Trim old entries
            const cutoff = now - TRAIL_MS
            const trimmed = trail.filter(s => s.ts >= cutoff).slice(-MAX_TRAIL)
            trailsRef.current.set(key, trimmed)
          })
        } catch {}
      }
    })

    return () => sources.forEach(s => s.close())
  }, [zones, base])

  // ── Always-on fake persons (demo zone) ────────────────────────────────────
  useEffect(() => {
    const FAKE_PERSONS = [
      {
        key: 'fake::P001', id: 'P001', threat: 0.15,
        move: (t: number) => ({
          x: 0.5 + 0.38 * Math.cos(t * 0.8),
          y: 0.5 + 0.38 * Math.sin(t * 0.8),
        }),
      },
      {
        key: 'fake::P002', id: 'P002', threat: 0.72,
        move: (t: number) => ({
          x: 0.5 + 0.38 * Math.sin(t * 0.6),
          y: 0.5 + 0.22 * Math.sin(t * 1.2),
        }),
      },
      {
        key: 'fake::P003', id: 'P003', threat: 0.45,
        move: (t: number) => {
          const p = (t * 0.4) % 1
          const row = Math.floor(t * 0.4) % 2
          return { x: p, y: 0.3 + 0.4 * (row === 0 ? p : 1 - p) }
        },
      },
      {
        key: 'fake::P004', id: 'P004', threat: 0.08,
        move: (t: number) => {
          const p = (t * 0.3) % 4
          if (p < 1) return { x: 0.1 + p * 0.8, y: 0.1 }
          if (p < 2) return { x: 0.9, y: 0.1 + (p - 1) * 0.8 }
          if (p < 3) return { x: 0.9 - (p - 2) * 0.8, y: 0.9 }
          return { x: 0.1, y: 0.9 - (p - 3) * 0.8 }
        },
      },
      {
        key: 'fake::P005', id: 'P005', threat: 0.61,
        move: (t: number) => {
          const r = 0.42 * Math.max(0.05, 1 - ((t * 0.15) % 1))
          return { x: 0.5 + r * Math.cos(t * 1.5), y: 0.5 + r * Math.sin(t * 1.5) }
        },
      },
      {
        key: 'fake::P006', id: 'P006', threat: 0.33,
        move: (t: number) => ({
          x: 0.5 + 0.3 * Math.sin(t * 0.7 + 1.2) * Math.cos(t * 0.3),
          y: 0.5 + 0.3 * Math.cos(t * 0.5 + 2.4) * Math.sin(t * 0.4),
        }),
      },
    ]

    const interval = setInterval(() => {
      const now = Date.now()
      const t   = now / 2000
      FAKE_PERSONS.forEach(fp => {
        const pos = fp.move(t)
        const snap: PersonSnapshot = {
          id:     fp.id,
          x:      Math.max(0.02, Math.min(0.98, pos.x)),
          y:      Math.max(0.02, Math.min(0.98, pos.y)),
          ts:     now,
          threat: fp.threat,
        }
        const trail = trailsRef.current.get(fp.key) ?? []
        trail.push(snap)
        const cutoff = now - TRAIL_MS
        trailsRef.current.set(fp.key, trail.filter(s => s.ts >= cutoff).slice(-MAX_TRAIL))
      })
    }, 150)

    return () => clearInterval(interval)
  }, [])

  // ── Canvas render loop ─────────────────────────────────────────────────────

  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height
    const { x: ox, y: oy, scale } = viewRef.current

    ctx.clearRect(0, 0, W, H)

    // Dark background
    ctx.fillStyle = '#0a0c0f'
    ctx.fillRect(0, 0, W, H)

    // Subtle grid background
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.03)'
    ctx.lineWidth = 0.5
    for (let gx = -30; gx < 30; gx++) {
      for (let gy = -30; gy < 30; gy++) {
        const [px, py] = isoProject(gx, gy)
        const sx = W / 2 + ox + px * scale
        const sy = H / 2 + oy + py * scale
        // Just draw dots
        ctx.fillStyle = 'rgba(255,255,255,0.04)'
        ctx.fillRect(sx, sy, 1, 1)
      }
    }
    ctx.restore()

    // Draw zones and persons
    const now = Date.now()
    let totalPersons = 0, totalAlerts = 0

    // Determine which zones to render — always include DEMO ZONE for fake persons
    const demoZone: CamZone = {
      cam_id: 'fake', label: 'DEMO ZONE',
      col: zones.length > 0 ? zones.length * (ZONE_W + 2) : 0,
      row: 0,
      color: ZONE_COLORS[5].stroke,
    }
    const renderZones: CamZone[] = [...zones, demoZone]

    renderZones.forEach((zone, zi) => {

      const palette = ZONE_COLORS[zi % ZONE_COLORS.length]
      const gc = zone.col, gr = zone.row

      // Draw floor tiles
      for (let tx = 0; tx < ZONE_W; tx++) {
        for (let ty = 0; ty < ZONE_D; ty++) {
          const gx = gc + tx, gy = gr + ty
          const [px, py] = isoProject(gx, gy)
          const cx = W / 2 + ox + px * scale
          const cy = H / 2 + oy + py * scale
          const hw = CELL_W * scale
          const hh = CELL_H * scale

          ctx.beginPath()
          ctx.moveTo(cx,      cy - hh)
          ctx.lineTo(cx + hw, cy)
          ctx.lineTo(cx,      cy + hh)
          ctx.lineTo(cx - hw, cy)
          ctx.closePath()

          // Gradient fill for depth
          const grad = ctx.createLinearGradient(cx - hw, cy, cx + hw, cy)
          grad.addColorStop(0,   palette.fill + 'cc')
          grad.addColorStop(0.5, palette.fill + '88')
          grad.addColorStop(1,   palette.fill + 'aa')
          ctx.fillStyle = grad
          ctx.fill()
          ctx.strokeStyle = palette.stroke + '44'
          ctx.lineWidth = 0.5 * scale
          ctx.stroke()
        }
      }

      // Zone border highlight
      const corners = [
        isoProject(gc,          gr),
        isoProject(gc + ZONE_W, gr),
        isoProject(gc + ZONE_W, gr + ZONE_D),
        isoProject(gc,          gr + ZONE_D),
      ]
      ctx.beginPath()
      corners.forEach(([px, py], i) => {
        const sx = W / 2 + ox + px * scale
        const sy = H / 2 + oy + py * scale
        i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy)
      })
      ctx.closePath()
      ctx.strokeStyle = palette.stroke + 'aa'
      ctx.lineWidth = 1.5 * scale
      ctx.stroke()

      // Zone label
      const [lx, ly] = isoProject(gc + ZONE_W / 2, gr - 1)
      ctx.font = `bold ${Math.max(8, 11 * scale)}px 'Inter', monospace`
      ctx.fillStyle = palette.glow
      ctx.textAlign = 'center'
      ctx.shadowColor = palette.glow
      ctx.shadowBlur = 8
      ctx.fillText(zone.label, W / 2 + ox + lx * scale, H / 2 + oy + ly * scale)
      ctx.shadowBlur = 0

      // -- Persons in this zone --
      const zoneTrails = Array.from(trailsRef.current.entries()).filter(([k]) =>
        k.startsWith(zone.cam_id + '::')
      )

      zoneTrails.forEach(([key, trail]) => {
        if (trail.length === 0) return
        const latest = trail[trail.length - 1]
        if (now - latest.ts > TRAIL_MS) return
        totalPersons++
        if (latest.threat >= 0.6) totalAlerts++

        // World grid pos of this person (within zone)
        const toGrid = (snap: PersonSnapshot): [number, number] => [
          gc + snap.x * (ZONE_W - 1) + 0.5,
          gr + snap.y * (ZONE_D - 1) + 0.5,
        ]

        const personColor = latest.threat >= 0.6 ? '#ef4444'
          : latest.threat >= 0.3 ? '#f59e0b'
          : '#22c55e'

        // Draw trail
        if (trail.length > 1) {
          ctx.save()
          for (let i = 1; i < trail.length; i++) {
            const prev = trail[i - 1]
            const curr = trail[i]
            const age  = (now - curr.ts) / TRAIL_MS
            const alpha = Math.max(0, 1 - age) * 0.6

            const [pxA, pyA] = isoProject(...toGrid(prev))
            const [pxB, pyB] = isoProject(...toGrid(curr))

            ctx.beginPath()
            ctx.moveTo(W / 2 + ox + pxA * scale, H / 2 + oy + pyA * scale)
            ctx.lineTo(W / 2 + ox + pxB * scale, H / 2 + oy + pyB * scale)
            ctx.strokeStyle = personColor + Math.round(alpha * 255).toString(16).padStart(2, '0')
            ctx.lineWidth = Math.max(1, 2 * scale * (1 - age * 0.7))
            ctx.stroke()
          }
          ctx.restore()
        }

        // Draw person orb at latest position
        const [pgx, pgy] = toGrid(latest)
        const [ppx, ppy] = isoProject(pgx, pgy)
        const sx = W / 2 + ox + ppx * scale
        const sy = H / 2 + oy + ppy * scale
        const r  = Math.max(5, 9 * scale)

        // Glow pulse (using ts as phase)
        const pulse = 0.7 + 0.3 * Math.sin((now / 600) + trail.length)

        // Shadow
        ctx.save()
        ctx.globalAlpha = 0.3 * pulse
        ctx.beginPath()
        ctx.ellipse(sx, sy + r * 0.4, r * 1.2, r * 0.4, 0, 0, Math.PI * 2)
        ctx.fillStyle = personColor
        ctx.fill()
        ctx.globalAlpha = 1

        // Orb glow
        const glowGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 2)
        glowGrad.addColorStop(0, personColor + 'aa')
        glowGrad.addColorStop(1, personColor + '00')
        ctx.beginPath()
        ctx.arc(sx, sy, r * 2, 0, Math.PI * 2)
        ctx.fillStyle = glowGrad
        ctx.fill()

        // Orb body
        const orbGrad = ctx.createRadialGradient(sx - r * 0.3, sy - r * 0.3, r * 0.1, sx, sy, r)
        orbGrad.addColorStop(0, '#ffffff99')
        orbGrad.addColorStop(0.4, personColor)
        orbGrad.addColorStop(1,   personColor + '88')
        ctx.beginPath()
        ctx.arc(sx, sy, r, 0, Math.PI * 2)
        ctx.fillStyle = orbGrad
        ctx.fill()
        ctx.strokeStyle = '#ffffff33'
        ctx.lineWidth = 0.5
        ctx.stroke()

        // Vertical pole
        ctx.beginPath()
        ctx.moveTo(sx, sy)
        ctx.lineTo(sx, sy + r * 2)
        ctx.strokeStyle = personColor + '66'
        ctx.lineWidth = 1
        ctx.stroke()

        // Person ID label
        const labelY = sy - r - 4
        ctx.font = `bold ${Math.max(8, 10 * scale)}px 'Inter', monospace`
        ctx.textAlign = 'center'
        // Badge background
        const lw = ctx.measureText(latest.id).width + 8
        ctx.fillStyle = 'rgba(0,0,0,0.75)'
        ctx.beginPath()
        ctx.roundRect(sx - lw / 2, labelY - 10, lw, 14, 3)
        ctx.fill()
        ctx.fillStyle = personColor
        ctx.shadowColor = personColor
        ctx.shadowBlur = 6
        ctx.fillText(latest.id, sx, labelY)
        ctx.shadowBlur = 0

        // Threat % badge
        const threatStr = `${Math.round(latest.threat * 100)}%`
        ctx.font = `${Math.max(7, 8 * scale)}px monospace`
        ctx.fillStyle = 'rgba(255,255,255,0.55)'
        ctx.fillText(threatStr, sx, labelY + 12)

        ctx.restore()
      })
    })

    setStats({ persons: totalPersons, cameras: renderZones.length, alerts: totalAlerts })

    animRef.current = requestAnimationFrame(render)
  }, [zones])

  useEffect(() => {
    animRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animRef.current)
  }, [render])

  // ── Resize canvas to fill container ───────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const obs = new ResizeObserver(() => {
      const el = containerRef.current
      const canvas = canvasRef.current
      if (!el || !canvas) return
      canvas.width  = el.clientWidth
      canvas.height = el.clientHeight
    })
    if (containerRef.current) obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [])

  // ── Pan handlers ──────────────────────────────────────────────────────────
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      ox: viewRef.current.x, oy: viewRef.current.y,
    }
  }
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragRef.current) return
    viewRef.current.x = dragRef.current.ox + (e.clientX - dragRef.current.startX)
    viewRef.current.y = dragRef.current.oy + (e.clientY - dragRef.current.startY)
  }
  const onMouseUp = () => { dragRef.current = null }

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.1 : 0.9
    viewRef.current.scale = Math.max(0.3, Math.min(4, viewRef.current.scale * factor))
  }

  const resetView = () => { viewRef.current = { x: 0, y: 0, scale: 1 } }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      display: 'flex', flexDirection: 'column',
      background: '#0a0c0f',
      fontFamily: "'Inter', 'JetBrains Mono', monospace",
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 16px',
        background: 'rgba(255,255,255,0.04)',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        flexShrink: 0,
      }}>
        {/* Icon */}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7c6fff" strokeWidth="1.5">
          <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/>
          <circle cx="12" cy="12" r="3" fill="#7c6fff44"/>
        </svg>
        <span style={{ fontWeight: 700, fontSize: 13, color: '#e2e8f0', letterSpacing: 0.5 }}>
          3D Tracking Map
        </span>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginLeft: -6 }}>
          ISOMETRIC VIEW
        </span>

        {/* Stats pills */}
        <div style={{ display: 'flex', gap: 6, marginLeft: 12 }}>
          {[
            { label: 'CAMERAS', val: stats.cameras, color: '#7c6fff' },
            { label: 'PERSONS', val: stats.persons, color: '#22c55e' },
            { label: 'ALERTS',  val: stats.alerts,  color: stats.alerts > 0 ? '#ef4444' : '#4b5563' },
          ].map(s => (
            <div key={s.label} style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'rgba(255,255,255,0.06)',
              border: `1px solid ${s.color}33`,
              borderRadius: 6, padding: '2px 8px',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.color, boxShadow: `0 0 5px ${s.color}` }} />
              <span style={{ fontSize: 10, color: s.color, fontWeight: 700 }}>{s.val}</span>
              <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>{s.label}</span>
            </div>
          ))}
        </div>

        {/* Controls */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)' }}>
            Drag to pan · Scroll to zoom
          </span>
          <button onClick={resetView} style={{
            background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)',
            color: 'rgba(255,255,255,0.6)', borderRadius: 6, padding: '4px 10px',
            fontSize: 11, cursor: 'pointer',
          }}>⌖ Reset</button>
          <button onClick={onClose} style={{
            background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
            color: '#f87171', borderRadius: 6, padding: '4px 10px',
            fontSize: 11, cursor: 'pointer',
          }}>✕ Close</button>
        </div>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        style={{ flex: 1, cursor: dragRef.current ? 'grabbing' : 'grab', overflow: 'hidden' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={onWheel}
      >
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      </div>

      {/* Legend */}
      <div style={{
        display: 'flex', gap: 16, alignItems: 'center',
        padding: '8px 16px',
        background: 'rgba(0,0,0,0.4)',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        fontSize: 10, color: 'rgba(255,255,255,0.4)',
        flexShrink: 0,
      }}>
        {[
          { color: '#22c55e', label: 'Low threat (< 30%)' },
          { color: '#f59e0b', label: 'Medium (30–60%)' },
          { color: '#ef4444', label: 'High threat (> 60%)' },
        ].map(l => (
          <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: l.color, boxShadow: `0 0 5px ${l.color}` }} />
            <span>{l.label}</span>
          </div>
        ))}
        <span style={{ marginLeft: 'auto' }}>
          Trail duration: {TRAIL_MS / 1000}s · Max points: {MAX_TRAIL}
        </span>
      </div>
    </div>
  )
}
