# android-minecraft-agent

Drive a **real Minecraft Bedrock** client on Android (redroid) inside a KVM guest, from the
`mc` CLI. This repo is the client backend for agent-driven Minecraft work (screenshots, input,
chat, joining servers) — a replacement for the unstable Linux `mcpelauncher` client.

- **First time here / environment not set up:** follow [SETUP.md](./SETUP.md).
- **Using it:** see [skills/android-minecraft/SKILL.md](./skills/android-minecraft/SKILL.md).

## Quick reference

```bash
mc launch --id main            # resume ~1.3s, cold boot ~20s; starts Minecraft
mc screenshot --width 426 --out /tmp/s.png   # then read /tmp/s.png
mc click 426 240               # coordinates are in the last screenshot's pixels
mc chat "hello"
mc connect <host> [port]       # join a server (client must be signed into Xbox)
mc stop                        # pause (fast relaunch); --remove frees memory
mc list
```

Rules: screenshot then act on it; game buttons may need `--action press --hold-ms 150`; only
touch your own instances (`mc list`); run `mc` from the repo with the `MC_*` env from
[SETUP.md](./SETUP.md) set.

## Layout

| Path | What |
|---|---|
| `src/lib.ts` | Core (the one source of truth) |
| `src/mc.ts` | `mc` CLI |
| `guest/` | QEMU guest + redroid/GApps image |
| `SETUP.md` | Full setup runbook |
| `skills/android-minecraft/` | Agent skill |
