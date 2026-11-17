# elevenlabs-voicestudio-shim

A local server that answers the VoiceStudio app's speech and sound-effect API with ElevenLabs. A tool written to narrate through VoiceStudio
then speaks with an ElevenLabs account instead, with no change to the tool.

## Use

Needs Node 22+ and an ElevenLabs API key.

```sh
export ELEVENLABS_API_KEY=...
node elevenlabs-voice.mjs --voice "Sarah"
```

It listens on port 3900, VoiceStudio's own port, so a tool that calls VoiceStudio there reaches it as is.

| Option | Default | |
| --- | --- | --- |
| `--voice` | the account's first voice | ElevenLabs voice name or id |
| `--alias` | none | an extra profile name for `--voice`, for a tool that asks for one voice by a fixed name |
| `--model` | `eleven_v4_turbo` | any ElevenLabs text-to-speech model |
| `--port` | `3900` | |

Every ElevenLabs voice on the account is listed under its own name too.

## What it does

It is a middleware: VoiceStudio's request in, an ElevenLabs request out. The endpoints follow VoiceStudio's own backend
([debpalash/VoiceStudio](https://github.com/debpalash/VoiceStudio), `backend/api/routers/profiles.py`, `generation.py` and
`sfx.py`).

- `GET /profiles` lists the account's voices as VoiceStudio `voice_profiles` rows (`id` is the ElevenLabs voice id,
  `language` is `Auto`, `seed` is `null`). The `--alias` profile comes first, with the id `alias-<voice id>`.
- `POST /generate` takes VoiceStudio's multipart form and answers with `audio/wav` (16-bit, 24 kHz) and VoiceStudio's
  `X-Audio-Id`, `X-Audio-Path`, `X-Audio-Duration`, `X-Gen-Time` and `X-Seed` headers.
  - `text` is required. `profile_id` picks the voice. A missing or unknown one speaks with `--voice`, as VoiceStudio
    speaks with its default voice.
  - `seed` is passed to ElevenLabs. Without one a seed is drawn and returned in `X-Seed`, as VoiceStudio does.
  - `speed` is passed as ElevenLabs' `voice_settings.speed`, kept within its 0.7 to 1.2.
  - `stream=true` is refused with a 422. VoiceStudio streams NDJSON events for it, and this shim answers with a WAV only.
  - Every other VoiceStudio field (`language`, `instruct`, `ref_audio`, `guidance_scale`, `num_step` and the rest) is
    accepted and ignored. ElevenLabs detects the language from the text.
- Errors come back as `{"detail": "..."}`. A rate-limited or failing ElevenLabs answers 429 or 503 with `Retry-After: 30`
  and `X-OmniVoice-Retryable: true`, VoiceStudio's busy answer. Any other ElevenLabs error is a 502.

- `POST /api/sfx/generate` takes VoiceStudio's JSON (`prompt`, `duration`, `seed`), asks ElevenLabs' sound generation
  (`eleven_text_to_sound_v2`) and answers `{id, audio_url, duration_s, gen_time_s, seed, engine}`. `audio_url` is
  `/audio/<id>.wav`, served by `GET /audio/<file>` from a temporary folder, as VoiceStudio serves its takes under `/audio`.
  - VoiceStudio's limits hold: a prompt of 1 to 500 characters (whitespace collapsed), `duration` from 1 to 30 seconds
    (default 10, rounded to 0.1). A bad request gets VoiceStudio's `sfx_prompt_required`, `sfx_prompt_too_long` or
    `sfx_bad_duration` error, or FastAPI's validation list for a body that fails the request model.
  - The WAV is 16-bit stereo at 24 kHz, as ElevenLabs sends it. VoiceStudio's own engine makes mono 48 kHz. PCM at 44.1 kHz
    and up needs an ElevenLabs Pro plan, so 24 kHz works on every plan.
  - ElevenLabs takes no seed for sound effects. `seed` is drawn when missing and handed back, but it does not repeat a take.
  - A rate-limited or failing ElevenLabs answers 503 `sfx_busy`, retryable. Any other ElevenLabs error is a 500 `sfx_failed`
    whose message carries ElevenLabs' answer.

Other VoiceStudio endpoints (`/api/sfx/status`, dubbing, the OpenAI-compatible `/v1` API and the rest) are not served.

Each request costs ElevenLabs credits.

## Test

```sh
npm test
```

The tests run the server against a fake ElevenLabs and spend no credits.

## License

MIT
