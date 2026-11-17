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

test("errors come back in FastAPI's shape, a busy ElevenLabs as a retryable 429", async () => {
  const empty = await generate({ text: "" });
  assert.equal(empty.status, 422); assert.deepEqual(await empty.json(), { detail: "text is required" });
  const busy = await generate({ text: "busy", profile_id: "v1" });
  assert.equal(busy.status, 429); assert.equal(busy.headers.get("x-omnivoice-retryable"), "true"); assert.equal(busy.headers.get("retry-after"), "30");
  assert.match((await busy.json()).detail, /429: too many/);
});
