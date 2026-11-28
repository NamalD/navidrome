// A hidden <audio> playing silence on a loop while the engine plays.
//
// Browsers tie media controls (media keys, the lock screen and notification controls) and permission to keep
// playing in a background tab or with the screen off to a media element that is playing. Web Audio alone
// doesn't count, so this element plays alongside it. It is ten seconds long because Chrome ignores shorter
// media for its media controls.

const SECONDS = 10
const RATE = 8000

const silentWav = () => {
  const samples = SECONDS * RATE
  const bytes = new Uint8Array(44 + samples)
  const view = new DataView(bytes.buffer)
  const text = (offset, s) =>
    [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE, true) // bytes per second
  view.setUint16(32, 1, true) // block align
  view.setUint16(34, 8, true) // bits per sample
  text(36, 'data')
  view.setUint32(40, samples, true)
  bytes.fill(0x80, 44) // silence in unsigned 8-bit PCM
  return new Blob([bytes], { type: 'audio/wav' })
}

export const createSessionKeeper = () => {
  let audio = null
  let url = null
  return {
    play() {
      if (!audio) {
        url = URL.createObjectURL(silentWav())
        audio = new Audio(url)
        audio.loop = true
      }
      audio.play().catch(() => {
        // Not allowed yet (no user gesture); the engine's own play() reports that.
      })
    },
    pause() {
      if (audio) audio.pause()
    },
    destroy() {
      if (audio) audio.pause()
      if (url) URL.revokeObjectURL(url)
      audio = null
      url = null
    },
  }
}
