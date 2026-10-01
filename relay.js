/**
 * LIMS analyzer relay — for analyzers that wait to be connected to.
 *
 * Most analyzers call out: you type the LIS server's IP and port into them and
 * they connect to the central gateway on the droplet by themselves (Erba H-360,
 * Indo-Medx Cellomax). Some never call out — the Mindray BC-5150 has no LIS
 * address setting at all; it listens on the lab network (port 5100) and waits
 * for the LIS to connect to IT. The droplet can't reach into a lab's private
 * network, so this small program runs on a PC in the lab and joins the two:
 *
 *   analyzer (listening, LAN) <--- relay on a lab PC ---> central gateway :<lab port>
 *
 * It is a plain pipe: every byte from the analyzer goes to the gateway and
 * every byte back (the HL7 ACK) goes to the analyzer. It does not parse or
 * store anything — the gateway and the LIMS do all the work, exactly as for an
 * analyzer that connected by itself. The lab is still identified by the port.
 *
 * The gateway link is opened FIRST and the analyzer is only connected while it
 * is up. An analyzer with no LIS attached keeps its results (they can be
 * re-sent from its review screen); one that believes a LIS is attached sends
 * them, and they would be lost if the far end were down.
 *
 * Config: relay.env next to this file (copy relay.env.example), or real
 * environment variables, which take precedence.
 *
 * Run:      node relay.js
 * Service:  npm run relay:install   (Administrator; starts on every boot)
 */

const fs = require('fs')
const net = require('net')
const path = require('path')

function loadEnvFile(file) {
  let text
  try {
    text = fs.readFileSync(path.join(__dirname, file), 'utf8')
  } catch {
    return
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (key && !(key in process.env)) process.env[key] = value
  }
}
loadEnvFile('relay.env')

// The analyzer on the lab network (its own IP, from its Communication screen).
const ANALYZER_HOST = process.env.ANALYZER_HOST
const ANALYZER_PORT = Number(process.env.ANALYZER_PORT || 5100)
// The central gateway and this lab's port on it (LIMS -> Instrument Mappings).
const GATEWAY_HOST = process.env.GATEWAY_HOST || '209.38.124.112'
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT)

// Share mode: also serve the analyzer's results to the lab's existing software
// (e.g. Pathosys), which connects HERE instead of to the analyzer — the
// analyzer accepts only one connection. Unset = relay to the gateway only.
const SHARE_PORT = process.env.SHARE_PORT ? Number(process.env.SHARE_PORT) : null
const SHARE_HOST = process.env.SHARE_HOST || '0.0.0.0'
// Bytes held for the gateway while it is unreachable in share mode.
const MAX_PENDING_BYTES = 5 * 1024 * 1024

const RETRY_MS = Number(process.env.RELAY_RETRY_MS || 5000)
const CONNECT_TIMEOUT_MS = Number(process.env.RELAY_CONNECT_TIMEOUT_MS || 10000)
// Keep-alive probes so a link an ISP's NAT dropped silently is noticed and redialled.
const KEEPALIVE_MS = Number(process.env.RELAY_KEEPALIVE_MS || 30000)

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

if (!ANALYZER_HOST || !Number.isInteger(GATEWAY_PORT)) {
  log('Missing config: set ANALYZER_HOST and GATEWAY_PORT in relay.env (see relay.env.example).')
  process.exit(1)
}

/** Opens a TCP connection, resolving once connected or rejecting on failure/timeout. */
function connect(host, port, label) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`${label} ${host}:${port} did not answer within ${CONNECT_TIMEOUT_MS}ms`))
    }, CONNECT_TIMEOUT_MS)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.setKeepAlive(true, KEEPALIVE_MS)
      socket.setNoDelay(true)
      resolve(socket)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`${label} ${host}:${port}: ${err.message}`))
    })
  })
}

/**
 * One relay session: gateway first, then the analyzer, then pipe both ways
 * until either side ends. Resolves when the session is over.
 */
async function session() {
  const gateway = await connect(GATEWAY_HOST, GATEWAY_PORT, 'gateway')
  let analyzer
  try {
    analyzer = await connect(ANALYZER_HOST, ANALYZER_PORT, 'analyzer')
  } catch (err) {
    gateway.destroy()
    throw err
  }
  log(`Relaying analyzer ${ANALYZER_HOST}:${ANALYZER_PORT} <-> gateway ${GATEWAY_HOST}:${GATEWAY_PORT}`)

  let toGateway = 0
  analyzer.on('data', (chunk) => {
    toGateway += chunk.length
    gateway.write(chunk)
  })
  gateway.on('data', (chunk) => analyzer.write(chunk))

  await new Promise((resolve) => {
    let over = false
    const end = (why) => {
      if (over) return
      over = true
      analyzer.destroy()
      gateway.destroy()
      log(`Session ended (${why}); ${toGateway} bytes relayed from the analyzer`)
      resolve()
    }
    analyzer.on('close', () => end('analyzer closed the connection'))
    gateway.on('close', () => end('gateway closed the connection'))
    analyzer.on('error', (err) => end(`analyzer error: ${err.message}`))
    gateway.on('error', (err) => end(`gateway error: ${err.message}`))
  })
}

/**
 * Share mode. The analyzer link is kept up on its own (the lab's existing
 * software must keep receiving even when the internet is down), and every
 * byte from the analyzer goes to both the gateway and the connected share
 * clients. The existing software stays the analyzer's conversation partner:
 * its replies reach the analyzer, while the gateway's ACKs are dropped so the
 * analyzer never hears two answers. While the gateway is unreachable its copy
 * is held in memory (up to 5 MB) and sent on reconnect.
 */
function shareMode() {
  const clients = new Set()
  let analyzer = null
  let gateway = null
  let pending = []
  let pendingBytes = 0

  const toGateway = (chunk) => {
    if (gateway) {
      gateway.write(chunk)
      return
    }
    pendingBytes += chunk.length
    if (pendingBytes > MAX_PENDING_BYTES) {
      log('Gateway unreachable for too long; dropping held results (re-send them from the analyzer).')
      pending = []
      pendingBytes = 0
      return
    }
    pending.push(chunk)
  }

  // Analyzer link — redialled forever, independent of the gateway.
  const dialAnalyzer = async () => {
    try {
      analyzer = await connect(ANALYZER_HOST, ANALYZER_PORT, 'analyzer')
    } catch (err) {
      log(`Cannot connect: ${err.message}. Retrying every ${RETRY_MS / 1000}s…`)
      setTimeout(dialAnalyzer, RETRY_MS)
      return
    }
    log(`Connected to analyzer ${ANALYZER_HOST}:${ANALYZER_PORT}`)
    analyzer.on('data', (chunk) => {
      for (const client of clients) client.write(chunk)
      toGateway(chunk)
    })
    const lost = (why) => {
      if (!analyzer) return
      analyzer.destroy()
      analyzer = null
      log(`Analyzer link lost (${why}); redialling in ${RETRY_MS / 1000}s`)
      setTimeout(dialAnalyzer, RETRY_MS)
    }
    analyzer.on('close', () => lost('closed by the analyzer'))
    analyzer.on('error', (err) => lost(err.message))
  }

  // Gateway link — redialled forever; what it sends back is dropped.
  let lastGatewayError = ''
  const dialGateway = async () => {
    try {
      gateway = await connect(GATEWAY_HOST, GATEWAY_PORT, 'gateway')
    } catch (err) {
      if (err.message !== lastGatewayError) {
        log(`Cannot connect: ${err.message}. Retrying every ${RETRY_MS / 1000}s…`)
        lastGatewayError = err.message
      }
      setTimeout(dialGateway, RETRY_MS)
      return
    }
    lastGatewayError = ''
    log(`Connected to gateway ${GATEWAY_HOST}:${GATEWAY_PORT}`)
    if (pending.length > 0) {
      log(`Sending ${pendingBytes} bytes held while the gateway was unreachable`)
      for (const chunk of pending) gateway.write(chunk)
      pending = []
      pendingBytes = 0
    }
    gateway.on('data', () => {})
    const lost = (why) => {
      if (!gateway) return
      gateway.destroy()
      gateway = null
      log(`Gateway link lost (${why}); holding results and redialling in ${RETRY_MS / 1000}s`)
      setTimeout(dialGateway, RETRY_MS)
    }
    gateway.on('close', () => lost('closed'))
    gateway.on('error', (err) => lost(err.message))
  }

  // The existing software connects here as if this PC were the analyzer.
  const server = net.createServer((client) => {
    const peer = `${client.remoteAddress}:${client.remotePort}`
    client.setKeepAlive(true, KEEPALIVE_MS)
    client.setNoDelay(true)
    clients.add(client)
    log(`Existing software connected (${peer}); sharing results with it`)
    client.on('data', (chunk) => {
      if (analyzer) analyzer.write(chunk)
    })
    const gone = () => {
      if (!clients.delete(client)) return
      log(`Existing software disconnected (${peer})`)
    }
    client.on('close', gone)
    client.on('error', gone)
  })
  server.on('error', (err) => {
    log(`Cannot listen on ${SHARE_HOST}:${SHARE_PORT} for the existing software: ${err.message}`)
    process.exit(1)
  })
  server.listen(SHARE_PORT, SHARE_HOST, () =>
    log(`Sharing results: existing software can connect to this PC on port ${SHARE_PORT}`)
  )

  void dialGateway()
  void dialAnalyzer()
}

async function main() {
  if (SHARE_PORT) {
    log(
      `LIMS analyzer relay starting (share mode): analyzer ${ANALYZER_HOST}:${ANALYZER_PORT}, ` +
        `gateway ${GATEWAY_HOST}:${GATEWAY_PORT}, existing software on port ${SHARE_PORT}`
    )
    shareMode()
    return
  }
  log(
    `LIMS analyzer relay starting: analyzer ${ANALYZER_HOST}:${ANALYZER_PORT}, gateway ${GATEWAY_HOST}:${GATEWAY_PORT}`
  )
  let lastError = ''
  for (;;) {
    try {
      await session()
      lastError = ''
    } catch (err) {
      // Log a repeating failure once, not every few seconds (analyzer switched
      // off overnight, internet down).
      if (err.message !== lastError) {
        log(`Cannot connect: ${err.message}. Retrying every ${RETRY_MS / 1000}s…`)
        lastError = err.message
      }
    }
    await new Promise((r) => setTimeout(r, RETRY_MS))
  }
}

main()
