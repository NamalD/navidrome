// Splits a FLAC stream into whole frames while it downloads, so the gapless engine can decode it in pieces.
//
// The browser's decodeAudioData only decodes complete files. A FLAC file is a header followed by frames that
// decode independently and carry no encoder delay, so "minimal header + a run of whole frames" is itself a
// valid file that decodes to exactly those frames' samples. Decoding pieces in order and playing them back to
// back therefore reproduces the track sample for sample, and playback can start after the first piece arrives.
//
// Frame boundaries are found the way a decoder resyncs (RFC 9639): a sync code, a header whose CRC-8 matches
// and whose frame or sample number follows the previous frame's, and a CRC-16 over the frame before it that
// comes out as zero. Together these rule out sync codes that happen to occur inside audio data.

const CRC8_TABLE = new Uint8Array(256)
const CRC16_TABLE = new Uint16Array(256)
for (let i = 0; i < 256; i++) {
  let c8 = i
  let c16 = i << 8
  for (let bit = 0; bit < 8; bit++) {
    c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff
    c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff
  }
  CRC8_TABLE[i] = c8
  CRC16_TABLE[i] = c16
}

const crc8 = (bytes, start, end) => {
  let crc = 0
  for (let i = start; i < end; i++) crc = CRC8_TABLE[crc ^ bytes[i]]
  return crc
}

const STREAMINFO_LENGTH = 34

// Reads the stream header. Returns null until enough bytes have arrived, and throws if this isn't FLAC.
// `header` is a stand-alone header for decoding pieces: "fLaC" and STREAMINFO only (no cover art or tags),
// with the total sample count and MD5 cleared because a piece holds fewer samples than the whole track.
export const parseFlacHeader = (bytes) => {
  if (bytes.length < 4) return null
  if (
    bytes[0] !== 0x66 ||
    bytes[1] !== 0x4c ||
    bytes[2] !== 0x61 ||
    bytes[3] !== 0x43
  ) {
    throw new Error('not a FLAC stream')
  }
  let pos = 4
  let streamInfo = null
  for (;;) {
    if (bytes.length < pos + 4) return null
    const isLast = (bytes[pos] & 0x80) !== 0
    const type = bytes[pos] & 0x7f
    const length =
      (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]
    if (bytes.length < pos + 4 + length) return null
    if (type === 0) {
      streamInfo = readStreamInfo(bytes, pos + 4)
      const header = new Uint8Array(4 + 4 + STREAMINFO_LENGTH)
      header.set(bytes.subarray(0, 4), 0)
      header.set([0x80, 0, 0, STREAMINFO_LENGTH], 4)
      header.set(bytes.subarray(pos + 4, pos + 4 + STREAMINFO_LENGTH), 8)
      // total samples: low 4 bits of byte 13 of STREAMINFO and the 4 bytes after it; then the 16-byte MD5
      header[8 + 13] &= 0xf0
      header.fill(0, 8 + 14, 8 + STREAMINFO_LENGTH)
      streamInfo.header = header
    }
    pos += 4 + length
    if (isLast) break
  }
  if (!streamInfo) throw new Error('FLAC stream has no STREAMINFO')
  return { ...streamInfo, framesStart: pos }
}

const readStreamInfo = (b, p) => ({
  minBlockSize: (b[p] << 8) | b[p + 1],
  maxBlockSize: (b[p + 2] << 8) | b[p + 3],
  sampleRate: (b[p + 10] << 12) | (b[p + 11] << 4) | (b[p + 12] >> 4),
  channels: ((b[p + 12] >> 1) & 0x07) + 1,
  bitsPerSample: (((b[p + 12] & 0x01) << 4) | (b[p + 13] >> 4)) + 1,
})

const SAMPLE_RATES = [
  0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000,
  96000,
]
const SAMPLE_SIZES = [0, 8, 12, 0, 16, 20, 24, 32]

// Parses the frame header at `p`. Returns { number, blockSize, variable } when it is a plausible header for
// this stream, null when it isn't, and undefined when the header runs past the bytes received so far.
export const parseFrameHeader = (bytes, p, info) => {
  if (bytes.length < p + 4) return undefined
  if (bytes[p] !== 0xff || (bytes[p + 1] & 0xfe) !== 0xf8) return null
  const variable = (bytes[p + 1] & 0x01) === 1
  const blockCode = bytes[p + 2] >> 4
  const rateCode = bytes[p + 2] & 0x0f
  const channelCode = bytes[p + 3] >> 4
  const sizeCode = (bytes[p + 3] >> 1) & 0x07
  if (blockCode === 0 || rateCode === 15 || (bytes[p + 3] & 0x01) !== 0) {
    return null
  }
  const channels = channelCode < 8 ? channelCode + 1 : channelCode <= 10 ? 2 : 0
  if (channels !== info.channels) return null
  if (sizeCode === 3) return null
  if (sizeCode !== 0 && SAMPLE_SIZES[sizeCode] !== info.bitsPerSample) {
    return null
  }
  if (
    rateCode >= 1 &&
    rateCode <= 11 &&
    SAMPLE_RATES[rateCode] !== info.sampleRate
  ) {
    return null
  }

  // Frame number (fixed block size) or sample number (variable), in FLAC's UTF-8-like coding
  let q = p + 4
  if (bytes.length < q + 1) return undefined
  const first = bytes[q]
  let extra
  if (first < 0x80) extra = 0
  else if (first >= 0xc0 && first < 0xe0) extra = 1
  else if (first >= 0xe0 && first < 0xf0) extra = 2
  else if (first >= 0xf0 && first < 0xf8) extra = 3
  else if (first >= 0xf8 && first < 0xfc) extra = 4
  else if (first >= 0xfc && first < 0xfe) extra = 5
  else if (first === 0xfe) extra = 6
  else return null
  if (bytes.length < q + 1 + extra) return undefined
  let number = extra === 0 ? first : first & (0x3f >> extra)
  for (let i = 1; i <= extra; i++) {
    const cont = bytes[q + i]
    if ((cont & 0xc0) !== 0x80) return null
    number = number * 64 + (cont & 0x3f)
  }
  q += 1 + extra

  let blockSize
  if (blockCode === 1) blockSize = 192
  else if (blockCode <= 5) blockSize = 576 << (blockCode - 2)
  else if (blockCode === 6) {
    if (bytes.length < q + 1) return undefined
    blockSize = bytes[q] + 1
    q += 1
  } else if (blockCode === 7) {
    if (bytes.length < q + 2) return undefined
    blockSize = ((bytes[q] << 8) | bytes[q + 1]) + 1
    q += 2
  } else blockSize = 256 << (blockCode - 8)

  if (rateCode === 12) q += 1
  else if (rateCode === 13 || rateCode === 14) q += 2
  if (bytes.length < q + 1) return undefined
  if (crc8(bytes, p, q) !== bytes[q]) return null
  return { number, blockSize, variable }
}

// Finds frames in a FLAC stream as it grows. Call scan() after each new chunk of bytes, and finish() once the
// download is complete; both return the frames found since the previous call as { start, end, blockSize }.
export class FlacFrameScanner {
  constructor(info) {
    this.info = info
    this.frameStart = info.framesStart
    this.current = null // header of the frame that starts at frameStart
    this.pos = info.framesStart // next byte to fold into the CRC-16
    this.crc = 0
  }

  scan(bytes, final = false) {
    const frames = []
    if (!this.current) {
      const header = parseFrameHeader(bytes, this.frameStart, this.info)
      if (header === undefined) return frames
      if (header === null)
        throw new Error('FLAC stream has no frame where expected')
      this.current = header
    }
    let { crc, pos } = this
    // The shortest possible frame is a few bytes; start looking for the next sync after the current header.
    const minNext = this.frameStart + 6
    // Stop where a header might not have fully arrived; it is looked at again on the next call.
    const limit = final ? bytes.length : bytes.length - 16
    while (pos < limit) {
      if (
        pos >= minNext &&
        crc === 0 &&
        bytes[pos] === 0xff &&
        (bytes[pos + 1] & 0xfe) === 0xf8
      ) {
        const next = parseFrameHeader(bytes, pos, this.info)
        if (next && this.follows(next)) {
          frames.push({
            start: this.frameStart,
            end: pos,
            blockSize: this.current.blockSize,
          })
          this.frameStart = pos
          this.current = next
        }
      }
      crc = ((crc << 8) & 0xffff) ^ CRC16_TABLE[(crc >> 8) ^ bytes[pos]]
      pos++
    }
    this.crc = crc
    this.pos = pos
    return frames
  }

  finish(bytes) {
    const frames = this.scan(bytes, true)
    if (!this.current) return frames
    if (this.crc !== 0) throw new Error('FLAC stream ends inside a frame')
    frames.push({
      start: this.frameStart,
      end: bytes.length,
      blockSize: this.current.blockSize,
    })
    this.current = null
    this.frameStart = bytes.length
    this.pos = bytes.length
    return frames
  }

  follows(next) {
    const { current } = this
    if (next.variable !== current.variable) return false
    return current.variable
      ? next.number === current.number + current.blockSize
      : next.number === current.number + 1
  }
}
