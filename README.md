# elevenlabs-voicestudio-shim

A local server that answers the VoiceStudio app's API with ElevenLabs voices. A tool written to narrate through VoiceStudio
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

- `GET /profiles` lists the account's voices as VoiceStudio profiles.
- `POST /generate` takes VoiceStudio's form (`text`, `profile_id`, `speed`, `seed`), asks ElevenLabs for 24 kHz PCM and answers
  with a WAV. `speed` is kept within ElevenLabs' 0.7 to 1.2. The other VoiceStudio fields are ignored.

Each request costs ElevenLabs credits.

## Test

```sh
npm test
```

The tests run the server against a fake ElevenLabs and spend no credits.

## License

MIT
