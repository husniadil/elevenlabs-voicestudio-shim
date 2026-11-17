#!/usr/bin/env node
// Stands in for the VoiceStudio app's local TTS API so a tool written for it speaks with ElevenLabs.
//   ELEVENLABS_API_KEY=... node elevenlabs-voice.mjs [--port 3900] [--voice <name or id>] [--alias <name>] [--model eleven_v4_turbo]
// The two endpoints follow VoiceStudio's backend (debpalash/VoiceStudio, backend/api/routers/profiles.py and generation.py):
// GET /profiles lists the account's ElevenLabs voices as voice_profiles rows, plus --voice again under the name --alias.
// POST /generate takes VoiceStudio's form and answers with audio/wav and its X-Audio-* and X-Seed headers.
import { randomInt, randomUUID } from "node:crypto";
import http from "node:http";

const args = process.argv.slice(2), opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const KEY = process.env.ELEVENLABS_API_KEY, API = process.env.ELEVENLABS_API_URL ?? "https://api.elevenlabs.io/v1", RATE = 24000;
const port = +opt("--port", 3900), model = opt("--model", "eleven_v4_turbo"), wanted = opt("--voice", null), alias = opt("--alias", null);
if (!KEY) { console.error("FAILED set ELEVENLABS_API_KEY"); process.exit(1); }

const r = await fetch(API + "/voices", { headers: { "xi-api-key": KEY } });
if (!r.ok) { console.error(`FAILED ElevenLabs /voices answered ${r.status}: ${(await r.text()).slice(0, 300)}`); process.exit(1); }
const voices = (await r.json()).voices;
const main = wanted ? voices.find(v => v.name === wanted || v.voice_id === wanted) : voices[0];
if (!main) { console.error(`FAILED no ElevenLabs voice "${wanted}"; the account has: ${voices.map(v => v.name).join(", ")}`); process.exit(1); }
// One voice_profiles row (backend/core/db.py); the alias gets its own id, as a second VoiceStudio profile would.
const row = (v, id = v.voice_id, name = v.name) => ({
  id, name, ref_audio_path: null, ref_text: "", instruct: "", language: "Auto", locked_audio_path: "", seed: null, is_locked: 0,
  personality: "", description: v.description ?? "", is_demo: 0, verified_own_voice: 0, consent_text: "", consent_audio_path: "",
  consent_recorded_at: null, kind: "clone", vd_states: null, design_recipe: null, created_at: Date.now() / 1000, sync_id: null,
  consent_basis: "", consent_attested_at: null, image_url: null, audio_url: null,
});
const profiles = [...(alias ? [row(main, "alias-" + main.voice_id, alias)] : []), ...voices.map(v => row(v))];
const voiceOf = new Map(profiles.map(p => [p.id, p.id.replace(/^alias-/, "")]));

const wav = pcm => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
};

const server = http.createServer(async (req, res) => {
  // FastAPI's error shape; a busy upstream is VoiceStudio's retryable busy answer
  const fail = (code, detail, headers = {}) => { console.error(`${code} ${detail}`); res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify({ detail })); };
  try {
    if (req.method === "GET" && req.url === "/profiles") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(profiles)); }
    if (req.method !== "POST" || req.url !== "/generate") return fail(404, "Not Found");
    const form = await new Request("http://x", { method: "POST", headers: req.headers, body: req, duplex: "half" }).formData();
    const text = form.get("text")?.normalize("NFC");
    if (!text) return fail(422, "text is required");
    // VoiceStudio ignores a profile_id it does not have and speaks with its default voice; here that is --voice
    const asked = form.get("profile_id"), voice = voiceOf.get(asked) ?? main.voice_id;
    if (asked && !voiceOf.has(asked)) console.error(`profile_id "${asked}" is not a voice here; speaking with "${main.name}"`);
    const seedIn = Number.parseInt(form.get("seed"), 10), seed = Number.isInteger(seedIn) && seedIn >= 0 ? seedIn : randomInt(2 ** 31);
    const speed = Math.min(1.2, Math.max(0.7, +form.get("speed") || 1)), t0 = Date.now();
    const t = await fetch(`${API}/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_${RATE}`, {
      method: "POST", headers: { "xi-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: model, voice_settings: { speed }, seed }),
    });
    if (!t.ok) {
      const detail = `ElevenLabs answered ${t.status}: ${(await t.text()).slice(0, 300)}`;
      if (t.status === 429 || t.status >= 500) return fail(t.status === 429 ? 429 : 503, detail, { "Retry-After": "30", "X-OmniVoice-Retryable": "true" });
      return fail(502, detail);
    }
    const out = wav(Buffer.from(await t.arrayBuffer())), id = randomUUID().replaceAll("-", ""), seconds = (out.length - 44) / 2 / RATE;
    res.writeHead(200, {
      "content-type": "audio/wav", "X-Audio-Id": id, "X-Gen-Time": ((Date.now() - t0) / 1000).toFixed(2), "X-Audio-Path": id + ".wav",
      "X-Seed": String(seed), "X-Audio-Duration": seconds.toFixed(2),
    });
    res.end(out);
    console.log(`spoke ${text.length} chars (${seconds.toFixed(2)} s)`);
  } catch (e) { fail(500, e.message); }
}).listen(port, () => console.log(`elevenlabs-voice: http://localhost:${server.address().port}, voice "${main.name}" (${main.voice_id})${alias ? ` as "${alias}"` : ""}, model ${model}`));
