import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// ── Port + scheme discovery ───────────────────────────────────────────────────
// Three-layer strategy so port is NEVER missed:
//  1. onBackendPort / onBackendScheme (push)  — main sends when Python prints
//  2. getPort / getScheme (pull)              — renderer polls after load
//  3. HTTP probe fallback                     — plain browser dev without Electron

;(window as any).__FADE_PORT__   = null
;(window as any).__FADE_SCHEME__ = 'http'

function broadcastPort(port: number) {
  if ((window as any).__FADE_PORT__ === port) return
  ;(window as any).__FADE_PORT__ = port
  window.dispatchEvent(new CustomEvent('fade:port', { detail: port }))
  console.log('[Fade] Backend port:', port)
}

function broadcastScheme(scheme: string) {
  if ((window as any).__FADE_SCHEME__ === scheme) return
  ;(window as any).__FADE_SCHEME__ = scheme
  window.dispatchEvent(new CustomEvent('fade:scheme', { detail: scheme }))
  console.log('[Fade] Backend scheme:', scheme)
}

const eAPI = (window as any).electronAPI

if (eAPI?.onBackendPort) {
  // Layer 1 — push
  eAPI.onBackendPort((port: number) => broadcastPort(port))
  eAPI.onBackendScheme?.((scheme: string) => broadcastScheme(scheme))

  // Layer 2 — pull (handles timing race)
  let pollAttempts = 0
  const poll = async () => {
    if (pollAttempts++ > 20) return
    try {
      const port: number | null = await eAPI.getPort()
      if (port) {
        broadcastPort(port)
        const scheme = await eAPI.getScheme?.()
        if (scheme) broadcastScheme(scheme)
        return
      }
    } catch { return }
    setTimeout(poll, 500)
  }
  poll()
} else {
  // Layer 3 — plain browser dev (no Electron): HTTP probe
  const tryPorts = async () => {
    for (const p of [8000, 8001, 8002]) {
      for (const scheme of ['https', 'http']) {
        try {
          const r = await fetch(`${scheme}://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(500) })
          if (r.ok) { broadcastPort(p); broadcastScheme(scheme); return }
        } catch { /* try next */ }
      }
    }
    setTimeout(tryPorts, 1000)
  }
  tryPorts()
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
