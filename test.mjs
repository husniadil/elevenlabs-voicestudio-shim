// Runs the shim against a fake ElevenLabs, so the tests spend no credits: node --test
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { after, before, test } from "node:test";

const calls = [];
const fake = http.createServer((req, res) => {
  let body = ""; req.on("data", d => (body += d)).on("end", () => {
    calls.push({ url: req.url, key: req.headers["xi-api-key"], body: body && JSON.parse(body) });
    if (req.url === "/voices") return res.end(JSON.stringify({ voices: [{ voice_id: "v1", name: "Roger" }, { voice_id: "v2", name: "Sarah" }] }));
    if (req.url.startsWith("/text-to-speech/v1") && JSON.parse(body).text === "busy") { res.writeHead(429); return res.end("too many"); }
    if (req.url.startsWith("/text-to-speech/v")) return res.end(Buffer.alloc(4800)); // 0.1 s of 24 kHz 16-bit silence
    if (req.url.startsWith("/sound-generation")) {
      const { text, duration_seconds } = JSON.parse(body);
      if (text === "busy") { res.writeHead(503); return res.end("overloaded"); }
      if (text === "refused") { res.writeHead(401); return res.end("invalid api key"); }
      return res.end(Buffer.alloc(Math.round(duration_seconds * 24000) * 4)); // stereo, as ElevenLabs sends sound effects
    }
    res.writeHead(500); res.end("unexpected");
  });
});
let shim, url;

before(async () => {
  await new Promise(ok => fake.listen(0, ok));
  shim = spawn(process.execPath, ["elevenlabs-voice.mjs", "--port", "0", "--voice", "Sarah", "--alias", "Narrator"], { env: { ...process.env, ELEVENLABS_API_KEY: "k", ELEVENLABS_API_URL: `http://localhost:${fake.address().port}` } });
  url = await new Promise((ok, no) => { let s = ""; shim.stdout.on("data", d => { s += d; const m = s.match(/http:\/\/localhost:\d+/); if (m) ok(m[0]); }); shim.once("exit", c => no(new Error("shim exited " + c))); });
});
after(() => { shim.kill(); fake.close(); });

const generate = fields => fetch(url + "/generate", { method: "POST", body: Object.entries(fields).reduce((f, [k, v]) => (f.append(k, v), f), new FormData()) });
const lastTts = () => calls.filter(c => c.url.startsWith("/text-to-speech/")).at(-1);

test("profiles are voice_profiles rows, the --alias first under its own id", async () => {
  const p = await (await fetch(url + "/profiles")).json();
  assert.deepEqual(p.map(v => [v.name, v.id]), [["Narrator", "alias-v2"], ["Roger", "v1"], ["Sarah", "v2"]]);
  assert.equal(p[1].language, "Auto"); assert.equal(p[1].seed, null); assert.equal(p[1].kind, "clone");
});

test("generate answers with a WAV, VoiceStudio's headers, and sends the model, speed and seed", async () => {
  const r = await generate({ text: "Halo", profile_id: "alias-v2", speed: 0.92, seed: 7, guidance_scale: 2, num_step: 32 });
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "audio/wav");
  assert.equal(r.headers.get("x-seed"), "7"); assert.equal(r.headers.get("x-audio-duration"), "0.10");
  assert.match(r.headers.get("x-audio-id"), /^[0-9a-f]{32}$/); assert.equal(r.headers.get("x-audio-path"), r.headers.get("x-audio-id") + ".wav");
  const b = Buffer.from(await r.arrayBuffer());
  assert.equal(b.toString("ascii", 0, 4), "RIFF"); assert.equal(b.readUInt32LE(24), 24000); assert.equal(b.length, 44 + 4800);
  const call = lastTts();
  assert.equal(call.url, "/text-to-speech/v2?output_format=pcm_24000"); assert.equal(call.key, "k");
  assert.deepEqual(call.body, { text: "Halo", model_id: "eleven_v4_turbo", voice_settings: { speed: 0.92 }, seed: 7 });
});

test("with no seed, a seed is drawn and handed back in X-Seed", async () => {
  const r = await generate({ text: "Halo", profile_id: "v1" });
  assert.equal(r.status, 200); assert.equal(String(lastTts().body.seed), r.headers.get("x-seed"));
});

test("a missing or unknown profile_id speaks with --voice, as VoiceStudio uses its default voice", async () => {
  assert.equal((await generate({ text: "Halo" })).status, 200); assert.match(lastTts().url, /^\/text-to-speech\/v2\?/);
  assert.equal((await generate({ text: "Halo", profile_id: "nope" })).status, 200); assert.match(lastTts().url, /^\/text-to-speech\/v2\?/);
});

test("stream=true is refused with a 422 before ElevenLabs is asked, stream=false speaks", async () => {
  const before = calls.length;
  for (const stream of ["true", "1", "on", "True"]) {
    const r = await generate({ text: "Halo", stream });
    assert.equal(r.status, 422); assert.match((await r.json()).detail, /stream=true is not supported/);
  }
  assert.equal(calls.length, before);
  assert.equal((await generate({ text: "Halo", stream: "false" })).status, 200);
});

test("errors come back in FastAPI's shape, a busy ElevenLabs as a retryable 429", async () => {
  const empty = await generate({ text: "" });
  assert.equal(empty.status, 422); assert.deepEqual(await empty.json(), { detail: "text is required" });
  const busy = await generate({ text: "busy", profile_id: "v1" });
  assert.equal(busy.status, 429); assert.equal(busy.headers.get("x-omnivoice-retryable"), "true"); assert.equal(busy.headers.get("retry-after"), "30");
  assert.match((await busy.json()).detail, /429: too many/);
});

const sfx = body => fetch(url + "/api/sfx/generate", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const lastSfx = () => calls.filter(c => c.url.startsWith("/sound-generation")).at(-1);

test("sfx answers with VoiceStudio's JSON and its audio_url serves the WAV", async () => {
  const r = await sfx({ prompt: "  rain on a\n tin roof ", duration: 2.04, seed: 11 });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(Object.keys(j), ["id", "audio_url", "duration_s", "gen_time_s", "seed", "engine"]);
  assert.match(j.id, /^[0-9a-f]{32}$/); assert.equal(j.audio_url, `/audio/${j.id}.wav`);
  assert.equal(j.duration_s, 2); assert.equal(j.seed, 11); assert.equal(j.engine, "eleven_text_to_sound_v2"); assert.equal(typeof j.gen_time_s, "number");
  const call = lastSfx();
  assert.equal(call.url, "/sound-generation?output_format=pcm_24000"); assert.equal(call.key, "k");
  assert.deepEqual(call.body, { text: "rain on a tin roof", duration_seconds: 2, model_id: "eleven_text_to_sound_v2" });
  const a = await fetch(url + j.audio_url);
  assert.equal(a.status, 200); assert.equal(a.headers.get("content-type"), "audio/wav");
  const b = Buffer.from(await a.arrayBuffer());
  assert.equal(b.toString("ascii", 0, 4), "RIFF"); assert.equal(b.readUInt16LE(22), 2); assert.equal(b.readUInt32LE(28), 24000 * 4); assert.equal(b.length, 44 + 2 * 24000 * 4);
});

test("sfx defaults to 10 s and draws a seed when none is given", async () => {
  const j = await (await sfx({ prompt: "door slam" })).json();
  assert.equal(lastSfx().body.duration_seconds, 10); assert.equal(j.duration_s, 10);
  assert.ok(Number.isInteger(j.seed) && j.seed >= 0 && j.seed < 2 ** 31);
});

test("sfx refuses a bad request as VoiceStudio does, before ElevenLabs is asked", async () => {
  const before = calls.length, code = async (body, status) => { const r = await sfx(body); assert.equal(r.status, status); return (await r.json()).detail; };
  assert.equal((await code({ duration: 3 }, 422))[0].loc.join("."), "body.prompt");
  assert.equal((await code("{not json", 422))[0].type, "json_invalid");
  assert.equal((await code({ prompt: "x", seed: -1 }, 422))[0].loc.join("."), "body.seed");
  assert.equal((await code({ prompt: "x", seed: 2 ** 31 }, 422))[0].loc.join("."), "body.seed");
  assert.deepEqual(await code({ prompt: " \n " }, 422), { code: "sfx_prompt_required", error: "sfx_prompt_required", message: "Describe the sound you want first." });
  assert.equal((await code({ prompt: "x".repeat(501) }, 422)).code, "sfx_prompt_too_long");
  assert.equal((await code({ prompt: "x", duration: 0.9 }, 422)).code, "sfx_bad_duration");
  assert.equal((await code({ prompt: "x", duration: 30.1 }, 422)).code, "sfx_bad_duration");
  assert.equal(calls.length, before);
  assert.equal((await sfx({ prompt: "x".repeat(500), duration: 30 })).status, 200);
});

test("sfx turns a busy ElevenLabs into a retryable 503 and a refusal into sfx_failed", async () => {
  const busy = await sfx({ prompt: "busy", duration: 1 });
  assert.equal(busy.status, 503); assert.equal(busy.headers.get("x-omnivoice-retryable"), "true"); assert.equal(busy.headers.get("retry-after"), "30");
  assert.equal((await busy.json()).detail.code, "sfx_busy");
  const refused = await sfx({ prompt: "refused", duration: 1 });
  assert.equal(refused.status, 500);
  const d = (await refused.json()).detail;
  assert.equal(d.code, "sfx_failed"); assert.match(d.message, /401: invalid api key/);
});

test("/audio serves only a take this server made", async () => {
  assert.equal((await fetch(url + "/audio/" + "0".repeat(32) + ".wav")).status, 404);
  assert.equal((await fetch(url + "/audio/..%2Fetc%2Fpasswd")).status, 404);
});

test("sfx status has sfx.py's fields and says generation can run, without asking ElevenLabs", async () => {
  const before = calls.length, r = await fetch(url + "/api/sfx/status");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    engine_id: "eleven_text_to_sound_v2", installed: true, available: true, supported: true, reason: null, reason_code: null,
    install_allowed: true, download_bytes: 0, license: "ElevenLabs Terms of Service", model_repo: "eleven_text_to_sound_v2",
    min_seconds: 1, max_seconds: 30, default_seconds: 10, max_prompt_chars: 500,
  });
  assert.equal(calls.length, before);
});
