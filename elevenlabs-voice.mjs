#!/usr/bin/env node
// Stands in for the VoiceStudio app's local TTS and sound-effect API so a tool written for it uses ElevenLabs.
//   ELEVENLABS_API_KEY=... node elevenlabs-voice.mjs [--port 3900] [--voice <name or id>] [--alias <name>] [--model eleven_v4_turbo]
// The endpoints follow VoiceStudio's backend (debpalash/VoiceStudio, backend/api/routers/profiles.py, generation.py, sfx.py):
// GET /profiles lists the account's ElevenLabs voices as voice_profiles rows, plus --voice again under the name --alias.
// POST /generate takes VoiceStudio's form and answers with audio/wav and its X-Audio-* and X-Seed headers.
// GET /api/sfx/status says sound effects can run; POST /api/sfx/generate takes { prompt, duration, seed } and answers with
// VoiceStudio's JSON; GET /audio/<file> serves the WAV.
import { randomInt, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2), opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const KEY = process.env.ELEVENLABS_API_KEY, API = process.env.ELEVENLABS_API_URL ?? "https://api.elevenlabs.io/v1", RATE = 24000;
const port = +opt("--port", 3900), model = opt("--model", "eleven_v4_turbo"), wanted = opt("--voice", null), alias = opt("--alias", null);
if (!KEY) { console.error("FAILED set ELEVENLABS_API_KEY"); process.exit(1); }
// VoiceStudio's MOSS-SoundEffect limits (backend/engines/moss_sfx/__init__.py)
const SFX = { min: 1, max: 30, default: 10, maxPromptChars: 500, engine: "eleven_text_to_sound_v2" };
// sfx.py's _status(): nothing to install here, and the key already answered /voices at startup, so generation can run
const sfxStatus = {
  engine_id: SFX.engine, installed: true, available: true, supported: true, reason: null, reason_code: null, install_allowed: true,
  download_bytes: 0, license: "ElevenLabs Terms of Service", model_repo: SFX.engine,
  min_seconds: SFX.min, max_seconds: SFX.max, default_seconds: SFX.default, max_prompt_chars: SFX.maxPromptChars,
};
const outputs = fs.mkdtempSync(path.join(os.tmpdir(), "elevenlabs-voicestudio-shim-"));

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

// ElevenLabs' raw PCM is 16-bit: mono for speech, stereo for sound effects (checked against its wav_24000 answer)
const wav = (pcm, channels = 1) => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2 * channels, 28); h.writeUInt16LE(2 * channels, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
};

// POST /api/sfx/generate, as backend/api/routers/sfx.py: errors are { detail: { code, error, message } }, and a body that
// fails the request model gets FastAPI's validation list
async function sfx(req, res) {
  const send = (code, body, headers = {}) => { if (code >= 400) console.error(`${code} ${JSON.stringify(body)}`); res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  const fail = (code, err, message, headers) => send(code, { detail: { code: err, error: err, message } }, headers);
  const invalid = (type, field, msg) => send(422, { detail: [{ type, loc: ["body", field], msg }] });
  let body;
  try { body = JSON.parse(await new Request("http://x", { method: "POST", headers: req.headers, body: req, duplex: "half" }).text()); } catch { return invalid("json_invalid", 0, "JSON decode error"); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return invalid("model_attributes_type", "body", "Input should be a valid dictionary or object to extract fields from");
  if (body.prompt === undefined) return invalid("missing", "prompt", "Field required");
  if (typeof body.prompt !== "string") return invalid("string_type", "prompt", "Input should be a valid string");
  if (body.seed != null && !(Number.isInteger(body.seed) && body.seed >= 0 && body.seed <= 2 ** 31 - 1)) return invalid("int_type", "seed", `Input should be an integer from 0 to ${2 ** 31 - 1}`);
  const prompt = body.prompt.split(/\s+/).filter(Boolean).join(" ");
  if (!prompt) return fail(422, "sfx_prompt_required", "Describe the sound you want first.");
  if (prompt.length > SFX.maxPromptChars) return fail(422, "sfx_prompt_too_long", `The description is too long (maximum ${SFX.maxPromptChars} characters).`);
  const asked = body.duration === undefined ? SFX.default : Number(body.duration);
  if (!(asked >= SFX.min && asked <= SFX.max)) return fail(422, "sfx_bad_duration", `Duration must be between ${SFX.min} and ${SFX.max} seconds.`);
  // ElevenLabs takes no seed for sound effects: it is drawn as VoiceStudio does and handed back, and does not repeat a take
  const seconds = Math.round(asked * 10) / 10, seed = body.seed ?? randomInt(2 ** 31), t0 = Date.now();
  const t = await fetch(`${API}/sound-generation?output_format=pcm_${RATE}`, {
    method: "POST", headers: { "xi-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ text: prompt, duration_seconds: seconds, model_id: SFX.engine }),
  });
  if (!t.ok) {
    const upstream = `ElevenLabs answered ${t.status}: ${(await t.text()).slice(0, 300)}`;
    if (t.status === 429 || t.status >= 500) return fail(503, "sfx_busy", upstream, { "Retry-After": "30", "X-OmniVoice-Retryable": "true" });
    return fail(500, "sfx_failed", `Sound-effect generation failed. ${upstream}`);
  }
  const out = wav(Buffer.from(await t.arrayBuffer()), 2), id = randomUUID().replaceAll("-", "");
  fs.writeFileSync(path.join(outputs, id + ".wav"), out);
  const duration = Math.round((out.length - 44) / 4 / RATE * 100) / 100;
  send(200, { id, audio_url: `/audio/${id}.wav`, duration_s: duration, gen_time_s: Math.round(Date.now() - t0) / 1000, seed, engine: SFX.engine });
  console.log(`sound effect ${seconds} s: ${prompt.slice(0, 60)}`);
}

const server = http.createServer(async (req, res) => {
  // FastAPI's error shape; a busy upstream is VoiceStudio's retryable busy answer
  const fail = (code, detail, headers = {}) => { console.error(`${code} ${detail}`); res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify({ detail })); };
  try {
    if (req.method === "GET" && req.url === "/profiles") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(profiles)); }
    if (req.method === "GET" && /^\/audio\/[0-9a-f]{32}\.wav$/.test(req.url)) {
      const file = path.join(outputs, req.url.slice("/audio/".length));
      if (!fs.existsSync(file)) return fail(404, "Not Found");
      res.writeHead(200, { "content-type": "audio/wav" }); return fs.createReadStream(file).pipe(res);
    }
    if (req.method === "GET" && req.url === "/api/sfx/status") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(sfxStatus)); }
    if (req.method === "POST" && req.url === "/api/sfx/generate") return await sfx(req, res);
    if (req.method !== "POST" || req.url !== "/generate") return fail(404, "Not Found");
    const form = await new Request("http://x", { method: "POST", headers: req.headers, body: req, duplex: "half" }).formData();
    const text = form.get("text")?.normalize("NFC");
    if (!text) return fail(422, "text is required");
    // VoiceStudio streams NDJSON events here; answering with a WAV would hand that client the wrong format
    if (["true", "1", "yes", "on"].includes(String(form.get("stream") ?? "").toLowerCase())) return fail(422, "stream=true is not supported: this shim answers with a WAV only");
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
