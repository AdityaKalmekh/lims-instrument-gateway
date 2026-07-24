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

// One OBX per analyte: [code, text, value, unit, refRange, flag]. This is a
// representative 5-part-diff CBC panel; the real H-360 code set is confirmed
// from its dump and then maintained in the app's mapping table.
// NOTE units use the "10*3/uL" form, not "10^3/uL": a literal ^ is HL7's
// component separator and would be parsed as a field boundary. Real analyzers
// either use * / e notation or HL7-escape the ^ (\S\). Confirm the H-360's
// exact unit strings from its dump.
const ANALYTES = [
  ['WBC', 'White Blood Cell', '7.2', '10*3/uL', '4.0-10.0', 'N'],
  ['RBC', 'Red Blood Cell', '4.85', '10*6/uL', '4.5-5.5', 'N'],
  ['HGB', 'Hemoglobin', '14.2', 'g/dL', '13.0-17.0', 'N'],
  ['HCT', 'Hematocrit', '42.1', '%', '40.0-50.0', 'N'],
  ['MCV', 'Mean Corpuscular Volume', '86.8', 'fL', '83.0-101.0', 'N'],
  ['MCH', 'Mean Corpuscular Hemoglobin', '29.3', 'pg', '27.0-32.0', 'N'],
  ['MCHC', 'Mean Corpuscular Hb Concentration', '33.7', 'g/dL', '31.5-34.5', 'N'],
  ['RDW-CV', 'RDW-CV', '12.9', '%', '11.6-14.0', 'N'],
  ['RDW-SD', 'RDW-SD', '41.2', 'fL', '35.1-43.9', 'N'],
  ['PLT', 'Platelet', '250', '10*3/uL', '150-410', 'N'],
  ['MPV', 'Mean Platelet Volume', '9.8', 'fL', '9.0-13.0', 'N'],
  ['PDW', 'Platelet Distribution Width', '16.1', '%', '9.0-17.0', 'N'],
  ['PCT', 'Plateletcrit', '0.24', '%', '0.17-0.35', 'N'],
  ['NEU%', 'Neutrophils %', '58.4', '%', '40.0-74.0', 'N'],
  ['LYM%', 'Lymphocytes %', '31.2', '%', '19.0-48.0', 'N'],
  ['MON%', 'Monocytes %', '7.1', '%', '3.4-9.0', 'N'],
  ['EOS%', 'Eosinophils %', '2.8', '%', '0.0-7.0', 'N'],
  ['BAS%', 'Basophils %', '0.5', '%', '0.0-1.5', 'N'],
  ['NEU#', 'Neutrophils Absolute', '4.21', '10*3/uL', '2.0-7.0', 'N'],
  ['LYM#', 'Lymphocytes Absolute', '2.25', '10*3/uL', '1.0-3.0', 'N'],
  ['MON#', 'Monocytes Absolute', '0.51', '10*3/uL', '0.2-1.0', 'N'],
  ['EOS#', 'Eosinophils Absolute', '0.20', '10*3/uL', '0.0-0.5', 'N'],
  ['BAS#', 'Basophils Absolute', '0.04', '10*3/uL', '0.0-0.1', 'N'],
]

function buildMessage(barcode) {
  const now = ts()
  const segments = [
    `MSH|^~\\&|H360|ERBA|LIMS|LAB|${now}||ORU^R01|MSG${Date.now()}|P|2.3.1`,
    `PID|1||||DOE^JOHN||19850312|M`,
    `OBR|1||${barcode}|CBC^Complete Blood Count|||${now}`,
    ...ANALYTES.map(
      ([code, text, value, unit, ref, flag], i) =>
        `OBX|${i + 1}|NM|${code}^${text}||${value}|${unit}|${ref}|${flag}|||F`
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

