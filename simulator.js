/**
 * H-360 simulator — stands in for the real analyzer so the whole pipeline can
 * be tested without hardware. It opens an MLLP/TCP connection to the gateway,
 * sends one realistic ORU^R01 CBC result message, waits for the ACK, prints it,
 * and exits.
 *
 * The message shape follows HL7 v2.3.1 with the sample barcode in OBR-3 (the
 * gateway's default HL7_BARCODE_LOCATION). When the real H-360 is available,
 * capture its raw message and diff it against this fixture to confirm the
 * barcode field and OBX-3 codes; adjust config/mapping to match.
 *
 * Usage:
 *   node simulator.js [barcode] [--host H] [--port P]
 *   npm run simulate -- 250723001
 */

const net = require('net')
const { frame, createMllpParser } = require('./lib/mllp')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))

const BARCODE = positional[0] || '250723001'
const HOST = flag('host', process.env.GATEWAY_HOST || '127.0.0.1')
const PORT = Number(flag('port', process.env.INSTRUMENT_TCP_PORT || 5150))

/** HL7 timestamp YYYYMMDDHHMMSS. */
function ts(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

// One OBX per analyte: [identifier, value, unit, refRange, flag], copied from a
// real Erba H-360 message (captured 2026-07-30; values from a sample run
// 2026-09-26). The H-360 puts a LOINC code in OBX-3 component 1 and the readable
// code (WBC, HGB, ...) in component 2 — the gateway reads component 2 for this
// model. Flags are repeated ("L~A", "~N") exactly as the analyzer sends them.
// Units use "10*3/uL" because a literal ^ is HL7's component separator.
const ANALYTES = [
  ['6690-2^WBC^LN', '7.96', '10*3/uL', '3.50-9.50', '~N'],
  ['736-9^LYM%^LN', '46.1', '%', '20.0-50.0', '~N'],
  ['20482-6^GRAN%^LN', '34.3', '%', '50.0-70.0', 'L~A'],
  ['32155-4^MID%^LN', '19.6', '%', '3.0-9.0', 'H~A'],
  ['731-0^LYM#^LN', '3.67', '10*3/uL', '1.10-3.20', 'H~A'],
  ['19023-1^GRAN#^LN', '2.73', '10*3/uL', '2.00-7.00', '~N'],
  ['32154-7^MID#^LN', '1.56', '10*3/uL', '0.10-0.90', 'H~A'],
  ['789-8^RBC^LN', '5.06', '10*6/uL', '3.80-5.80', '~N'],
  ['718-7^HGB^LN', '15.0', 'g/dL', '11.5-17.5', '~N'],
  ['4544-3^HCT^LN', '46.9', '%', '35.0-50.0', '~N'],
  ['787-2^MCV^LN', '92.7', 'fL', '82.0-100.0', '~N'],
  ['785-6^MCH^LN', '29.6', 'pg', '27.0-34.0', '~N'],
  ['786-4^MCHC^LN', '31.9', 'g/dL', '31.6-35.4', '~N'],
  ['788-0^RDW-CV^LN', '14.1', '%', '11.5-14.5', '~N'],
  ['21000-5^RDW-SD^LN', '53.1', 'fL', '35.0-56.0', '~N'],
  ['777-3^PLT^LN', '231', '10*3/uL', '125-350', '~N'],
  ['32623-1^MPV^LN', '9.5', 'fL', '7.0-11.0', '~N'],
  ['32207-3^PDW-SD^LN', '11.5', 'fL', '9.0-17.0', '~N'],
  ['11090^PDW-CV^LN', '14.2', '%', '10.0-17.9', '~N'],
  ['11003^PCT^99MRC', '0.220', '%', '0.108-0.282', '~N'],
  ['48386-7^P-LCR^LN', '23.7', '%', '11.0-45.0', '~N'],
  ['34167-7^P-LCC^LN', '55', '10*3/uL', '30-90', '~N'],
]

function buildMessage(barcode) {
  const now = ts()
  const segments = [
    `MSH|^~\\&|H360|Erba|||${now}||ORU^R01|${now}_${Date.now() % 1000}|P|2.3.1||||||UNICODE`,
    `PID|1`,
    `PV1|1`,
    `OBR|1||${barcode}|01001^Automated Count^99MRC||${now}|${now}|||||||${now}||||||||||HM`,
    ...ANALYTES.map(
      ([identifier, value, unit, ref, flag], i) =>
        `OBX|${i + 1}|NM|${identifier}||${value}|${unit}|${ref}|${flag}|||F`
    ),
  ]
  return segments.join('\r') + '\r'
}

const socket = net.createConnection({ host: HOST, port: PORT }, () => {
  const message = buildMessage(BARCODE)
  console.log(`→ Connected to ${HOST}:${PORT}; sending ORU^R01 for barcode ${BARCODE}`)
  console.log(`  (${ANALYTES.length} OBX result segments)`)
  socket.write(frame(message))
})

const push = createMllpParser((ack) => {
  console.log('\n← ACK received:')
  console.log(ack.replace(/\r/g, '\n').trim())
  const accepted = /\bMSA\|AA\b/.test(ack)
  console.log(`\n${accepted ? '✓ Accepted (MSA|AA)' : '✗ Not accepted — check the ACK above'}`)
  socket.end()
})

socket.on('data', (chunk) => push(chunk))
socket.on('error', (err) => {
  console.error(`✗ Connection error: ${err.message}`)
  console.error(`  Is the gateway running and listening on ${HOST}:${PORT}?`)
  process.exit(1)
})
socket.on('close', () => process.exit(0))

// Safety timeout in case no ACK ever comes back.
setTimeout(() => {
  console.error('✗ Timed out waiting for ACK (10s).')
  process.exit(1)
}, 10000)

