/**
 * LIMS instrument gateway.
 *
 * A small on-premise Node service that receives HL7 result messages from lab
 * analyzers over MLLP/TCP (e.g. the Erba H-360 hematology analyzer, HL7 v2.3.1)
 * and forwards normalized results to the Next.js LIMS app over HTTP. It runs on
 * a PC inside the lab network — the analyzer is configured to transmit to this
 * machine's IP and TCP port.
 *
 * Flow per message:
 *   analyzer --(MLLP/TCP ORU^R01)--> gateway --(HTTPS POST)--> app /api/instruments/results
 *   gateway --(MLLP ACK)--> analyzer
 *
 * The gateway is intentionally "dumb": it parses the HL7, pulls the sample
 * barcode + one entry per OBX result, and POSTs them. All barcode->patient
 * matching and code->field mapping happens in the app, which owns the data.
 *
 * DIRECTION: results-only (unidirectional). The analyzer pushes results; the
 * gateway never queries it. Bidirectional host-query can be added later.
 *
 * Config is env-driven so the real analyzer's quirks (barcode field location,
 * ports) are matched without code changes — see README.md.
 */

const fs = require('fs')
const path = require('path')
const net = require('net')
const express = require('express')
const pino = require('pino')

const { createMllpParser, frame } = require('./lib/mllp')
const { parse, extractResults, buildAck } = require('./lib/hl7')

// Load config from a local .env file next to this script (if present) so the
// gateway behaves identically whether launched from a terminal or the Windows
// service — no machine-wide environment setup needed. Real environment values
// take precedence, so a shell export or service definition can still override.
function loadEnvFile() {
  let text
  try {
    text = fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
  } catch {
    return // No .env file — rely on the real environment.
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key && !(key in process.env)) process.env[key] = value
  }
}
loadEnvFile()

// --- Config -----------------------------------------------------------------

// Port the analyzer transmits HL7/MLLP to. Set this in the H-360's LIS menu.
const TCP_PORT = Number(process.env.INSTRUMENT_TCP_PORT || 5150)
// Small HTTP port for health checks / monitoring (not used by the analyzer).
const HTTP_PORT = Number(process.env.INSTRUMENT_HTTP_PORT || 4002)
// The LIMS app endpoint that ingests results.
const APP_INGEST_URL =
  process.env.APP_INGEST_URL || 'http://localhost:3000/api/instruments/results'
// Bearer secret shared with the app (must match INSTRUMENT_GATEWAY_SECRET there).
const GATEWAY_SECRET = process.env.INSTRUMENT_GATEWAY_SECRET || 'dev-secret'
// Label for which physical analyzer this gateway serves (stored with results).
const INSTRUMENT_ID = process.env.INSTRUMENT_ID || 'erba-h360'
// Where in the HL7 message the sample barcode lives. Default OBR-3 (filler
// order number); override once the real machine's dump is confirmed.
const BARCODE_LOCATION = process.env.HL7_BARCODE_LOCATION || 'OBR-3'
// Which OBX-3 component holds the analyte code (code^name^system). Default 1;
// set to 2 for analyzers that put a LOINC/local code in component 1 and the
// readable mnemonic (WBC, HGB, ...) in component 2 (e.g. the Erba H-360).
const CODE_COMPONENT = Number(process.env.HL7_CODE_COMPONENT || 1)
// How many times to retry the POST to the app before spooling to disk.
const FORWARD_ATTEMPTS = Number(process.env.FORWARD_ATTEMPTS || 3)
const FORWARD_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 10000)
// Messages that can't be delivered are written here so nothing is ever lost.
const SPOOL_DIR = path.join(__dirname, 'spool')

// Central mode (the droplet): one gateway serves every lab. Each lab's analyzer
// has its own port, assigned in the LIMS ("Connect analyzer"); the gateway polls
// the app for the port list and each port's parse settings, and sends the port
// with every result so the app knows the lab. Off by default so an on-prem
// gateway in a single lab behaves exactly as before.
const CENTRAL_MODE = process.env.CENTRAL_MODE === '1'
const CONNECTIONS_URL =
  process.env.CONNECTIONS_URL || APP_INGEST_URL.replace(/\/results\/?$/, '/connections')
const CONNECTIONS_POLL_MS = Number(process.env.CONNECTIONS_POLL_MS || 60000)
// Keep idle analyzer connections alive through ISP/NAT idle timeouts.
const KEEPALIVE_MS = Number(process.env.TCP_KEEPALIVE_MS || 60000)

const logger = pino({ level: process.env.INSTRUMENT_GATEWAY_LOG_LEVEL || 'info' })

// --- Forwarding to the app --------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * POSTs one parsed message to the app, retrying transient failures. On final
 * failure the raw HL7 is spooled to disk so it can be re-sent later; the
 * analyzer has already been ACKed by then (we did receive the message).
 */
async function forwardToApp(payload, raw) {
  for (let attempt = 1; attempt <= FORWARD_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(APP_INGEST_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GATEWAY_SECRET}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      })
      if (res.ok) {
        logger.info(
          { barcode: payload.barcode, results: payload.results.length },
          'Results forwarded to app'
        )
        return true
      }
      const body = await res.text().catch(() => '')
      logger.warn(
        { status: res.status, attempt, body: body.slice(0, 300) },
        'App rejected results'
      )
      // 4xx (e.g. unknown barcode) won't fix itself on retry — spool and stop.
      if (res.status >= 400 && res.status < 500) break
    } catch (err) {
      logger.warn({ attempt, err: err.message }, 'Forward attempt failed')
    }
    if (attempt < FORWARD_ATTEMPTS) await sleep(500 * attempt)
  }

  spool(raw, payload)
  return false
}

/** Persists an undeliverable message to disk for later replay. */
function spool(raw, payload) {
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const base = `${stamp}_${payload.barcode || 'no-barcode'}`
    fs.writeFileSync(path.join(SPOOL_DIR, `${base}.hl7`), raw, 'utf8')
    fs.writeFileSync(
      path.join(SPOOL_DIR, `${base}.json`),
      JSON.stringify(payload, null, 2),
      'utf8'
    )
    logger.error({ file: `${base}.hl7` }, 'Message spooled to disk (not delivered)')
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to spool undelivered message')
  }
}

// --- TCP / MLLP server ------------------------------------------------------

// --- Per-port config ----------------------------------------------------------

/** Parse settings for the legacy/single port, from env (on-prem behaviour). */
const envConfig = {
  instrumentId: INSTRUMENT_ID,
  barcodeLocation: BARCODE_LOCATION,
  codeComponent: CODE_COMPONENT,
}

/** port -> { instrumentId, barcodeLocation, codeComponent } from the app. */
let connectionsByPort = new Map()

/** Settings for a message that arrived on `port`. */
function configForPort(port) {
  return connectionsByPort.get(port) || envConfig
}

/** Handles one complete HL7 message: parse, ACK, forward. */
async function handleMessage(raw, socket, port) {
  const config = configForPort(port)
  let parsed
  try {
    parsed = parse(raw)
  } catch (err) {
    logger.error({ err: err.message }, 'Could not parse HL7 message')
    spool(raw, { barcode: null, parseError: err.message })
    // Tell the analyzer we couldn't accept it so an operator notices.
    try {
      socket.write(frame(buildErrorAck(raw, err.message)))
    } catch {
      /* socket may be gone */
    }
    return
  }

  const extracted = extractResults(parsed, {
    barcodeLocation: config.barcodeLocation,
    codeComponent: config.codeComponent,
  })

  // ACK immediately — analyzers expect a prompt reply and may stall without it.
  try {
    socket.write(frame(buildAck(parsed, { code: 'AA' })))
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to write ACK')
  }

  // Only result messages carry results. Some analyzers also send status
  // messages (the Cellomax sends SSU^U03 before every result); they are ACKed
  // above but not forwarded, or they'd clutter the LIMS as empty unmatched rows.
  if (extracted.messageType && !extracted.messageType.startsWith('ORU')) {
    logger.info({ port, type: extracted.messageType }, 'Skipped non-result message')
    return
  }

  if (!extracted.barcode) {
    logger.warn(
      { port, location: config.barcodeLocation },
      'No barcode found in message; forwarding anyway for the app to log'
    )
  }
  if (extracted.barcodeSource.usedFallback) {
    logger.warn(
      { port, used: extracted.barcodeSource.location, configured: config.barcodeLocation },
      'Barcode found via fallback location — check the analyzer model settings'
    )
  }

  const payload = {
    instrumentId: config.instrumentId,
    port,
    receivedAt: new Date().toISOString(),
    messageType: extracted.messageType,
    controlId: extracted.controlId,
    barcode: extracted.barcode || null,
    patient: extracted.patient,
    results: extracted.results,
    raw,
  }

  logger.info(
    { port, barcode: payload.barcode, type: payload.messageType, results: payload.results.length },
    'Message received'
  )

  await forwardToApp(payload, raw)
}

/** Best-effort ACK for a message we could not even parse. */
function buildErrorAck(raw, message) {
  // We can't rely on the parse, so emit a minimal AE ACK.
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const ts =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return (
    `MSH|^~\\&|LIMS-GATEWAY|LIMS|UNKNOWN|UNKNOWN|${ts}||ACK^R01|ACK${Date.now()}|P|2.3.1\r` +
    `MSA|AE||${String(message).slice(0, 80)}\r`
  )
}

/** Handles one analyzer TCP connection on `port`. */
function onAnalyzerConnection(socket, port) {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`
  logger.info({ port, peer }, 'Analyzer connected')
  // Analyzers hold one connection open for hours between samples; without
  // keep-alive probes an ISP's NAT drops it silently and the next result is lost.
  socket.setKeepAlive(true, KEEPALIVE_MS)

  const push = createMllpParser((message) => {
    handleMessage(message, socket, port).catch((err) =>
      logger.error({ err: err.message }, 'Unhandled error handling message')
    )
  })

  socket.on('data', (chunk) => {
    // Diagnostic raw capture: record exactly what the analyzer sends, before any
    // parsing, so an unfamiliar framing (ASTM vs HL7/MLLP) can be identified.
    // Enable by setting CAPTURE_RAW=1; writes to spool/raw-capture.log.
    if (process.env.CAPTURE_RAW === '1') {
      try {
        fs.mkdirSync(SPOOL_DIR, { recursive: true })
        const printable = chunk
          .toString('utf8')
          .replace(/[\x00-\x1f]/g, (c) => `<${c.charCodeAt(0)}>`)
        fs.appendFileSync(
          path.join(SPOOL_DIR, 'raw-capture.log'),
          `\n[${new Date().toISOString()}] ${peer} ${chunk.length} bytes\n` +
            `HEX: ${chunk.toString('hex')}\nTXT: ${printable}\n`
        )
      } catch (err) {
        logger.warn({ err: err.message }, 'raw capture failed')
      }
    }
    push(chunk)
  })
  socket.on('error', (err) => logger.warn({ port, peer, err: err.message }, 'Socket error'))
  socket.on('close', () => logger.info({ port, peer }, 'Analyzer disconnected'))
}

// --- Listeners ----------------------------------------------------------------

/** port -> { server, sockets:Set } for every port we listen on. */
const listeners = new Map()

function openPort(port) {
  if (listeners.has(port)) return
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    onAnalyzerConnection(socket, port)
  })
  server.on('error', (err) => {
    logger.error({ port, err: err.message }, 'Listener error')
    listeners.delete(port)
  })
  server.listen(port, () => logger.info({ port }, `Listening for HL7/MLLP on :${port}`))
  listeners.set(port, { server, sockets })
}

/** Stops listening on a port and drops its analyzers (connection paused/removed). */
function closePort(port) {
  const entry = listeners.get(port)
  if (!entry) return
  entry.server.close()
  for (const socket of entry.sockets) socket.destroy()
  listeners.delete(port)
  logger.info({ port }, 'Stopped listening (connection no longer active)')
}

/**
 * Central mode: fetch the active connections from the app and make the open
 * ports match. The env port (TCP_PORT) always stays open so an analyzer that
 * hasn't been given its own port yet keeps working. On a failed fetch nothing
 * changes — a LIMS outage must never close a lab's port.
 */
async function syncConnections() {
  let body
  try {
    const res = await fetch(CONNECTIONS_URL, {
      headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    })
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Could not fetch connections; keeping current ports')
      return
    }
    body = await res.json()
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not fetch connections; keeping current ports')
    return
  }

  const next = new Map()
  for (const c of body.connections || []) {
    if (!Number.isInteger(c.port)) continue
    next.set(c.port, {
      instrumentId: c.instrumentId,
      barcodeLocation: c.barcodeLocation,
      codeComponent: c.codeComponent,
    })
  }
  connectionsByPort = next

  for (const port of next.keys()) openPort(port)
  for (const port of Array.from(listeners.keys())) {
    if (port !== TCP_PORT && !next.has(port)) closePort(port)
  }
}

// --- HTTP health server -----------------------------------------------------

const app = express()
app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    centralMode: CENTRAL_MODE,
    instrumentId: INSTRUMENT_ID,
    tcpPort: TCP_PORT,
    ports: Array.from(listeners.keys()).sort((a, b) => a - b),
  })
)

// --- Start ------------------------------------------------------------------

logger.info(
  { tcpPort: TCP_PORT, ingest: APP_INGEST_URL, centralMode: CENTRAL_MODE },
  'Instrument gateway starting'
)
openPort(TCP_PORT)

if (CENTRAL_MODE) {
  void syncConnections()
  setInterval(() => void syncConnections(), CONNECTIONS_POLL_MS)
}

app.listen(HTTP_PORT, () => {
  logger.info(`Health endpoint on http://localhost:${HTTP_PORT}/health`)
})
