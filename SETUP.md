# Setup

Everything needed to go from a bare Linux host to a controllable Minecraft Bedrock client.
Written to be followed by an agent with shell access: each step ends with a check.

## Why a guest

`redroid` and the Google Android emulator do not boot on some very new hosts (e.g. Fedora 44
/ kernel 6.19: Android `init` aborts with `Failed to initialize property area`, exit 129; the
emulator segfaults in its bundled QEMU). An **Ubuntu 22.04 guest (kernel 5.15 LTS)** runs
redroid reliably, and one guest hosts several containers (one client each).

```
Host (any Linux with KVM)                    <- QEMU + adb only
└─ Ubuntu 22.04 guest, kernel 5.15           <- ssh :2222
   └─ Docker -> redroid 13 (Android 13)+GApps <- one container per client
      └─ Minecraft Bedrock (from Google Play) <- adb :5555, 5556, ...
```

## 0. Host prerequisites

```bash
# Debian/Ubuntu: sudo apt install qemu-kvm qemu-utils virglrenderer mesa-utils adb genisoimage
# Fedora:        sudo dnf install qemu-kvm virglrenderer mesa-dri-drivers android-tools genisoimage
curl -fsSL https://bun.sh/install | bash        # Bun (runs the mc CLI)
# optional but recommended: ImageMagick (fast screenshot downscaling)
#   Debian/Ubuntu: sudo apt install imagemagick ; Fedora: sudo dnf install ImageMagick
```

Checks (all must pass):

```bash
test -w /dev/kvm && echo kvm ok
qemu-system-x86_64 -device help | grep -q virtio-gpu-gl-pci && echo virtio-gpu ok
qemu-system-x86_64 -display help | grep -q egl-headless && echo egl-headless ok
ldconfig -p | grep -q virglrenderer && echo virglrenderer ok
ls /dev/dri/renderD128 && echo render node ok
command -v adb bun && echo tooling ok
```

## 1. Create the guest

```bash
VM=~/android-mc-vm && mkdir -p "$VM" && cd "$VM"
ssh-keygen -q -t ed25519 -N '' -f id_ed25519            # guest SSH key
curl -L -o jammy.img https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img
qemu-img create -f qcow2 -b jammy.img -F qcow2 disk.qcow2 60G

# cloud-init seed (from this repo's guest/ dir)
sed "s|REPLACE_WITH_YOUR_PUBLIC_KEY|$(cat id_ed25519.pub)|" /path/to/repo/guest/user-data > user-data
cp /path/to/repo/guest/meta-data .
genisoimage -quiet -output seed.iso -volid cidata -joliet -rock user-data meta-data
```

`guest/user-data` installs Docker, loads `binder_linux`, and creates user `lunar`
(passwordless sudo). It assumes the host kernel has `binder` built in or as a module.

## 2. Boot the guest

```bash
VM_DIR="$VM" /path/to/repo/guest/start-vm.sh
# forwards: ssh 2222, and one adb port per client (5555, 5556, ...)
```

Check (guest is up, right kernel):

```bash
ssh -i "$VM/id_ed25519" -p 2222 -o StrictHostKeyChecking=no lunar@127.0.0.1 \
  'uname -r; sudo docker --version; lsmod | grep binder'
# expect: 5.15.x-... ; Docker ... ; binder_linux ...
```

## 3. Build the Android image (in the guest)

```bash
scp -i "$VM/id_ed25519" -P 2222 /path/to/repo/guest/Dockerfile lunar@127.0.0.1:/home/lunar/
ssh -i "$VM/id_ed25519" -p 2222 lunar@127.0.0.1 \
  'cd ~ && sudo docker build -t lunar/redroid13-gapps .'
```

This is redroid 13 (Android 13) with MindTheGapps overlaid, so Google Play works.

## 4. Install the CLI

```bash
git clone git@github.com:RestartFU/android-minecraft-agent.git
cd android-minecraft-agent
cat >> ~/.bashrc <<'EOF'
export MC_ADB=adb
export MC_SSH_KEY=$HOME/android-mc-vm/id_ed25519
export MC_SSH_TARGET=lunar@127.0.0.1
export MC_SSH_PORT=2222
export MC_IMAGE=lunar/redroid13-gapps
export MC_GPU_MODE=host
export MC_PORT_BASE=5555
EOF
. ~/.bashrc
```

Check: `bun run src/mc.ts list` prints `[]` (no instances yet).

## 5. First run: install Minecraft and sign in

```bash
mc launch --id main --data-dir /data/mc/main     # cold boot ~20s, starts Minecraft
mc screenshot --width 426 --out /tmp/s.png       # read /tmp/s.png
```

On a fresh `/data` the client is logged out. Do this once, by tapping coordinates from
screenshots (`mc click X Y --action press --hold-ms 150` for game buttons):

1. **Play Store** → sign in with a Google account → install **Minecraft**.
2. In Minecraft: **Sign In** → Microsoft/Xbox account (approve 2FA on your phone). Xbox
   sign-in is required to join online servers; Play sign-in alone is not enough.

Both persist in `/data/mc/main`, so later `launch` calls skip this.

Check: `mc state` shows Minecraft focused, `mc screenshot` shows the game.

## 6. Use it

```bash
mc connect zeqa.net 19132          # join a server (deep link)
mc chat "hello"                    # open chat, type, send
mc click 426 240                   # tap in the last screenshot's pixels
mc stop                            # pause (relaunch ~1.3s); --remove to free memory
```

For multiple clients, use distinct ids and data dirs; each gets the next forwarded port:

```bash
mc launch --id alt --data-dir /data/mc/alt
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `init: Failed to initialize property area` / container exits 129 | Host kernel too new for redroid. Use the 5.15 guest; do not run redroid on the host. |
| Emulator segfaults in QEMU | Same host-kernel issue. Use this guest, not the Google emulator. |
| `screenshot` empty / `state` blank | Stale adb connection. `mc` re-`adb connect`s automatically; if needed `adb disconnect && adb connect 127.0.0.1:<port>`. |
| `Connection refused` on ssh :2222 | Guest is down. Re-run `guest/start-vm.sh`. |
| Adb port unreachable | The port must be in `PORTS` in `guest/start-vm.sh`; the CLI only sees host-forwarded ports. |
| `gralloc-2-0 signal 8` in guest dmesg | Transient; check `dumpsys SurfaceFlinger \| grep GLES:` still reports `virgl`. |
| `InitialConnection-146` when joining | The client is not signed into Xbox Live (step 5). |
| Slow screenshots | Install ImageMagick (`magick`) for fast downscaling. |

## Layout

| Path | What |
|---|---|
| `src/lib.ts` | Core (containers, launch/stop, screenshot, input, chat) |
| `src/mc.ts` | `mc` CLI |
| `guest/start-vm.sh` | QEMU guest with virtio-gpu + port forwards |
| `guest/Dockerfile` | redroid 13 + MindTheGapps image |
| `guest/user-data`, `guest/meta-data` | cloud-init for the guest |
| `skills/android-minecraft/` | Agent skill for using the CLI |
