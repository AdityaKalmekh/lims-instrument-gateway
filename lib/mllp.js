/**
 * MLLP (Minimal Lower Layer Protocol) framing for HL7 over TCP.
 *
 * Analyzers wrap each HL7 message in three control bytes:
 *
 *   <VT> ...HL7 message bytes... <FS><CR>
 *
 *   VT (0x0B) = start-block, FS (0x1C) = end-block, CR (0x0D) = trailer.
 *
 * A single TCP read may contain part of a message, a whole message, or several
 * messages, so the parser accumulates bytes and emits one complete HL7 string
 * per fully-framed block.
 */

const VT = 0x0b // start of block
const FS = 0x1c // end of block
const CR = 0x0d // carriage return (block trailer)

/**
 * Creates a stateful framer for one TCP connection. Feed it each `data` chunk;
 * it calls `onMessage(hl7String)` once per complete MLLP block.
 *
 * @param {(message: string) => void} onMessage
 * @returns {(chunk: Buffer) => void} push
 */
function createMllpParser(onMessage) {
  let buffer = Buffer.alloc(0)

  return function push(chunk) {
    buffer = Buffer.concat([buffer, chunk])

    // Extract every complete block currently in the buffer.
    for (;;) {
      const start = buffer.indexOf(VT)
      if (start === -1) {
        // No start-of-block byte yet — treat everything seen so far as noise
        // (keep-alives, stray bytes) and drop it so the buffer can't grow
        // unbounded on a misbehaving peer.
        buffer = Buffer.alloc(0)
        return
      }

      const end = buffer.indexOf(FS, start + 1)
      if (end === -1) {
        // Start seen but no end yet — hold the partial message (from the start
        // byte onward) and wait for more data.
        if (start > 0) buffer = buffer.subarray(start)
        return
      }

      const message = buffer.subarray(start + 1, end).toString('utf8')

      // Consume through FS and the trailing CR if present.
      let next = end + 1
      if (buffer[next] === CR) next += 1
      buffer = buffer.subarray(next)

      if (message.trim().length > 0) onMessage(message)
    }
  }
}

/**
 * Wraps an HL7 message string in MLLP framing bytes, ready to write to a socket
 * (used to send the ACK back to the analyzer).
 *
 * @param {string} message
 * @returns {Buffer}
 */
function frame(message) {
  return Buffer.concat([
    Buffer.from([VT]),
    Buffer.from(message, 'utf8'),
    Buffer.from([FS, CR]),
  ])
}

module.exports = { createMllpParser, frame, VT, FS, CR }
