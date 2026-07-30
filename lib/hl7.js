/**
 * Minimal HL7 v2.x reader — just enough to understand an analyzer's ORU^R01
 * result message and build the ACK it expects. This is NOT a general HL7
 * engine; it deliberately handles only what a hematology analyzer sends.
 *
 * HL7 v2 layout:
 *   - Segments are separated by <CR>. Each starts with a 3-letter name
 *     (MSH, PID, OBR, OBX, ...).
 *   - Fields within a segment are separated by | .
 *   - A field can have components separated by ^ .
 *   - MSH is special: MSH-1 is the field separator itself and MSH-2 is the
 *     encoding characters, which shifts every later MSH field by one. We
 *     normalize that so callers can read MSH-3, MSH-10, etc. the natural way.
 */

/**
 * @typedef {{ name: string, fields: string[] }} Segment
 *   fields[0] is the segment name; fields[n] is HL7 field n (1-based).
 *
 * @typedef {{
 *   raw: string,
 *   fieldSep: string, compSep: string, repSep: string, escChar: string, subSep: string,
 *   segments: Segment[],
 * }} ParsedMessage
 */

/** Parses a raw HL7 message string into segments with 1-based field indexing. */
function parse(raw) {
  const lines = String(raw)
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  if (lines.length === 0) throw new Error('empty HL7 message')

  const mshLine = lines[0]
  if (!mshLine.startsWith('MSH')) {
    throw new Error(`message does not start with MSH (got "${mshLine.slice(0, 3)}")`)
  }

  const fieldSep = mshLine[3] || '|'
  const encoding = mshLine.slice(4, 8) // e.g. "^~\&"
  const compSep = encoding[0] || '^'
  const repSep = encoding[1] || '~'
  const escChar = encoding[2] || '\\'
  const subSep = encoding[3] || '&'

  const segments = lines.map((line) => {
    const parts = line.split(fieldSep)
    const name = parts[0]
    if (name === 'MSH') {
      // Re-index so fields[1] = field separator (MSH-1), fields[2] = encoding
      // chars (MSH-2), fields[3] = sending app (MSH-3), ...
      return { name, fields: ['MSH', fieldSep, ...parts.slice(1)] }
    }
    return { name, fields: parts }
  })

  return { raw, fieldSep, compSep, repSep, escChar, subSep, segments }
}

/** First segment with the given name, or null. */
function segment(parsed, name) {
  return parsed.segments.find((s) => s.name === name) || null
}

/** Raw value of field `n` (1-based) on a segment, or '' if absent. */
function field(seg, n) {
  if (!seg) return ''
  return seg.fields[n] ?? ''
}

/** Component `n` (1-based) of a field value, or '' if absent. */
function component(value, n, compSep) {
  if (!value) return ''
  return value.split(compSep)[n - 1] ?? ''
}

/**
 * Reads a value from a "SEG-field" or "SEG-field.component" location string,
 * e.g. "OBR-3" or "PID-3.1". Used for the configurable barcode location so the
 * real analyzer's quirk can be matched without a code change.
 */
function valueAt(parsed, location) {
  const match = /^([A-Z0-9]{3})-(\d+)(?:\.(\d+))?$/.exec(String(location).trim())
  if (!match) return ''
  const [, segName, fieldNum, compNum] = match
  const raw = field(segment(parsed, segName), Number(fieldNum))
  if (!compNum) return component(raw, 1, parsed.compSep) || raw
  return component(raw, Number(compNum), parsed.compSep)
}

/**
 * Extracts the sample barcode, message metadata, and one entry per OBX result
 * from a parsed ORU^R01. `barcodeLocation` defaults to OBR-3 (filler order
 * number), where most analyzers place the specimen/accession ID.
 *
 * @param {ParsedMessage} parsed
 * @param {{ barcodeLocation?: string, barcodeFallbacks?: string[], codeComponent?: number }} [opts]
 */
function extractResults(parsed, opts = {}) {
  const barcodeLocation = opts.barcodeLocation || 'OBR-3'
  const barcodeFallbacks = opts.barcodeFallbacks || ['OBR-2', 'PID-3']
  // Which component of OBX-3 (code^name^system) is the analyzer's result code.
  // Default 1 (the code). Some analyzers (e.g. Erba H-360) put a LOINC/local
  // code in component 1 and the friendly mnemonic (WBC, HGB, ...) in component
  // 2 — set codeComponent=2 there so mappings use the readable name.
  const codeComponent = Number(opts.codeComponent) || 1

  const msh = segment(parsed, 'MSH')
  const messageType = field(msh, 9) // e.g. "ORU^R01"
  const controlId = field(msh, 10)
  const version = field(msh, 12) || '2.3.1'

  let barcode = valueAt(parsed, barcodeLocation)
  const barcodeSource = { location: barcodeLocation, usedFallback: false }
  if (!barcode) {
    for (const loc of barcodeFallbacks) {
      const v = valueAt(parsed, loc)
      if (v) {
        barcode = v
        barcodeSource.location = loc
        barcodeSource.usedFallback = true
        break
      }
    }
  }

  const pid = segment(parsed, 'PID')
  const patient = {
    id: component(field(pid, 3), 1, parsed.compSep),
    name: field(pid, 5).replace(new RegExp(escapeRegExp(parsed.compSep), 'g'), ' ').trim(),
  }

  const results = parsed.segments
    .filter((s) => s.name === 'OBX')
    .map((obx) => {
      const identifier = field(obx, 3)
      return {
        valueType: field(obx, 2), // NM, ST, ...
        code: component(identifier, codeComponent, parsed.compSep), // configurable OBX-3 component
        text: component(identifier, 2, parsed.compSep), // friendly name (component 2)
        value: field(obx, 5),
        unit: component(field(obx, 6), 1, parsed.compSep),
        referenceRange: field(obx, 7),
        flag: field(obx, 8), // H / L / N / A ...
        status: field(obx, 11), // F (final), P (preliminary), ...
      }
    })
    // Drop OBX rows that carry no observation code (some analyzers emit blank
    // separators or non-result rows).
    .filter((r) => r.code)

  return { messageType, controlId, version, barcode, barcodeSource, patient, results }
}

/**
 * Builds an HL7 ACK for a received message, wrapped by the caller in MLLP.
 * `code` is the MSA acknowledgement code: AA (accept), AE (error), AR (reject).
 */
function buildAck(parsed, opts = {}) {
  const {
    code = 'AA',
    text = '',
    sendingApp = 'LIMS-GATEWAY',
    sendingFacility = 'LIMS',
  } = opts

  const msh = segment(parsed, 'MSH')
  const origSendingApp = field(msh, 3)
  const origSendingFacility = field(msh, 4)
  const origControlId = field(msh, 10)
  const version = field(msh, 12) || '2.3.1'

  const now = hl7Timestamp(new Date())
  const ackControlId = `ACK${Date.now()}`

  const mshOut = [
    'MSH',
    '^~\\&',
    sendingApp,
    sendingFacility,
    origSendingApp,
    origSendingFacility,
    now,
    '',
    'ACK^R01',
    ackControlId,
    'P',
    version,
  ].join('|')

  const msaOut = ['MSA', code, origControlId, text].join('|')

  return `${mshOut}\r${msaOut}\r`
}

/** HL7 timestamp: YYYYMMDDHHMMSS in local time. */
function hl7Timestamp(date) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

module.exports = { parse, segment, field, component, valueAt, extractResults, buildAck }
