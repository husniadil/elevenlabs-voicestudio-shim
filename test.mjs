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
    if (req.url.startsWith("/text-to-speech/v2")) return res.end(Buffer.alloc(4800)); // 0.1 s of 24 kHz 16-bit silence
    res.writeHead(422); res.end("bad voice");
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

test("profiles lists the voices and the --alias name for --voice", async () => {
  const p = await (await fetch(url + "/profiles")).json();
  assert.deepEqual(p.map(v => [v.name, v.id]), [["Narrator", "v2"], ["Roger", "v1"], ["Sarah", "v2"]]);
});

test("generate answers with a WAV and sends the model, speed and seed", async () => {
  const r = await generate({ text: "Halo", profile_id: "v2", speed: 0.92, seed: 7 });
  assert.equal(r.status, 200);
  const b = Buffer.from(await r.arrayBuffer());
  assert.equal(b.toString("ascii", 0, 4), "RIFF"); assert.equal(b.readUInt32LE(24), 24000); assert.equal(b.length, 44 + 4800);
  const call = calls.at(-1);
  assert.equal(call.url, "/text-to-speech/v2?output_format=pcm_24000"); assert.equal(call.key, "k");
  assert.deepEqual(call.body, { text: "Halo", model_id: "eleven_v4_turbo", voice_settings: { speed: 0.92 }, seed: 7 });
});

test("an ElevenLabs error comes back as a 502 with its message", async () => {
  const r = await generate({ text: "Halo", profile_id: "nope" });
  assert.equal(r.status, 502); assert.match(await r.text(), /422: bad voice/);
});
