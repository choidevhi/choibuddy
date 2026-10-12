// Short synthesized chimes, so the app ships no audio files.

let context: AudioContext | null = null

function audio(): AudioContext | null {
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') void context.resume()

    return context
  } catch {
    return null
  }
}

function tone(ctx: AudioContext, frequency: number, start: number, length: number, volume: number): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  const at = ctx.currentTime + start

  osc.type = 'sine'
  osc.frequency.setValueAtTime(frequency, at)
  gain.gain.setValueAtTime(0, at)
  gain.gain.linearRampToValueAtTime(volume, at + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length)
  osc.connect(gain).connect(ctx.destination)
  osc.start(at)
  osc.stop(at + length + 0.05)
}

export type Chime = 'pending' | 'done' | 'error'

export function playChime(kind: Chime): void {
  const ctx = audio()

  if (ctx === null) return

  switch (kind) {
    case 'pending':
      tone(ctx, 880, 0, 0.18, 0.16)
      tone(ctx, 1175, 0.14, 0.32, 0.14)
      break
    case 'done':
      tone(ctx, 660, 0, 0.16, 0.1)
      tone(ctx, 990, 0.1, 0.28, 0.08)
      break
    case 'error':
      tone(ctx, 330, 0, 0.22, 0.14)
      tone(ctx, 247, 0.16, 0.34, 0.12)
      break
  }
}

// Browsers keep audio locked until the first interaction; unlock it then.
export function unlockAudioOnInteraction(): void {
  const unlock = (): void => {
    audio()
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }

  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
}
