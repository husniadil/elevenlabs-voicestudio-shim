#!/usr/bin/env node
// Stands in for the VoiceStudio app's local API so a tool written for it speaks with ElevenLabs.
//   ELEVENLABS_API_KEY=... node elevenlabs-voice.mjs [--port 3900] [--voice <name or id>] [--alias <name>] [--model eleven_v4_turbo]
// GET /profiles lists the account's ElevenLabs voices, plus --voice again under the name --alias, when given.
// POST /generate (form: text, profile_id, speed, seed) answers with a real WAV made from ElevenLabs' raw PCM.
import http from "node:http";

const args = process.argv.slice(2), opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const KEY = process.env.ELEVENLABS_API_KEY, API = process.env.ELEVENLABS_API_URL ?? "https://api.elevenlabs.io/v1", RATE = 24000;
const port = +opt("--port", 3900), model = opt("--model", "eleven_v4_turbo"), wanted = opt("--voice", null), alias = opt("--alias", null);
if (!KEY) { console.error("FAILED set ELEVENLABS_API_KEY"); process.exit(1); }

const r = await fetch(API + "/voices", { headers: { "xi-api-key": KEY } });
if (!r.ok) { console.error(`FAILED ElevenLabs /voices answered ${r.status}: ${(await r.text()).slice(0, 300)}`); process.exit(1); }
const voices = (await r.json()).voices.map(v => ({ id: v.voice_id, name: v.name, language: "auto", seed: 0 }));
const main = wanted ? voices.find(v => v.name === wanted || v.id === wanted) : voices[0];
if (!main) { console.error(`FAILED no ElevenLabs voice "${wanted}"; the account has: ${voices.map(v => v.name).join(", ")}`); process.exit(1); }
const profiles = [...(alias ? [{ ...main, name: alias }] : []), ...voices];

const wav = pcm => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
};

const server = http.createServer(async (req, res) => {
  const fail = (code, msg) => { console.error(msg); res.writeHead(code, { "content-type": "text/plain" }); res.end(msg); };
  try {
    if (req.method === "GET" && req.url === "/profiles") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(profiles)); }
    if (req.method !== "POST" || req.url !== "/generate") return fail(404, "not found");
    const form = await new Request("http://x", { method: "POST", headers: req.headers, body: req, duplex: "half" }).formData();
    const text = form.get("text"), voice = form.get("profile_id"), speed = Math.min(1.2, Math.max(0.7, +form.get("speed") || 1));
    if (!text || !voice) return fail(400, "text and profile_id are required");
    const seed = Number.parseInt(form.get("seed"), 10);
    const t = await fetch(`${API}/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_${RATE}`, {
      method: "POST", headers: { "xi-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: model, voice_settings: { speed }, ...(Number.isFinite(seed) && seed > 0 ? { seed } : {}) }),
    });
    if (!t.ok) return fail(502, `ElevenLabs answered ${t.status}: ${(await t.text()).slice(0, 300)}`);
    const out = wav(Buffer.from(await t.arrayBuffer()));
    res.writeHead(200, { "content-type": "audio/wav" }); res.end(out);
    console.log(`spoke ${text.length} chars (${((out.length - 44) / 2 / RATE).toFixed(2)} s)`);
  } catch (e) { fail(500, "FAILED " + e.message); }
}).listen(port, () => console.log(`elevenlabs-voice: http://localhost:${server.address().port}, voice "${main.name}" (${main.id})${alias ? ` as "${alias}"` : ""}, model ${model}`));
