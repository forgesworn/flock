#!/usr/bin/env node
// Bake the radar voice vocabulary into on-device audio clips ONCE with OpenAI
// TTS, so runtime playback is fully offline / locked-phone safe (radar-v2).
//
//   OPENAI_API_KEY=… node scripts/gen-voice-clips.mjs [--force]
//
// Reads scripts/voice-clips.json (id → spoken text), writes app/public/voice/
// <id>.mp3. Idempotent: existing clips are skipped unless --force. The clips are
// content-stable — regenerate only when the vocabulary or voice changes.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(here, '../app/public/voice')
const VOCAB = resolve(here, 'voice-clips.json')

// A calm, clear, unhurried navigation voice. gpt-4o-mini-tts is steerable via
// `instructions`; the neutral British delivery matches the app's tone.
const MODEL = 'gpt-4o-mini-tts'
const VOICE = 'nova'
const INSTRUCTIONS =
  'You are a calm, clear, confident navigation guide. Neutral British accent. ' +
  'Unhurried and reassuring, never chirpy. Even pacing, gentle downward intonation at the end.'

const key = process.env.OPENAI_API_KEY
if (!key) { console.error('OPENAI_API_KEY is not set'); process.exit(1) }

const force = process.argv.includes('--force')
const vocab = JSON.parse(readFileSync(VOCAB, 'utf8'))
delete vocab._comment
mkdirSync(OUT, { recursive: true })

async function synth(id, text) {
  const dest = resolve(OUT, `${id}.mp3`)
  if (existsSync(dest) && !force) { console.log(`· skip ${id} (exists)`); return }
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, voice: VOICE, input: text, instructions: INSTRUCTIONS, response_format: 'mp3' }),
  })
  if (!res.ok) throw new Error(`${id}: ${res.status} ${await res.text()}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(dest, buf)
  console.log(`✓ ${id}  (${(buf.length / 1024).toFixed(1)} KB)  "${text}"`)
}

let ok = 0
for (const [id, text] of Object.entries(vocab)) {
  try { await synth(id, text); ok++ } catch (e) { console.error(`✗ ${id}: ${e.message}`); process.exitCode = 1 }
}
console.log(`\nDone — ${ok}/${Object.keys(vocab).length} clips in app/public/voice/`)
