#!/bin/bash
# Start the Ubuntu 22.04 KVM guest that hosts the redroid (Android) containers.
# Host GPU is exposed via virtio-gpu-gl + egl-headless (virgl -> radeonsi).
# Each client needs its adb port forwarded here; the CLI only sees host-forwarded ports.
set -euo pipefail

VM_DIR="${VM_DIR:-$HOME/lunar-vm}"        # holds disk.qcow2 and the cloud-init seed.iso
DISK="${DISK:-$VM_DIR/disk.qcow2}"
SEED="${SEED:-$VM_DIR/seed.iso}"
SSH_PORT="${SSH_PORT:-2222}"
PORTS="${PORTS:-5555 5556 5557 5558 5559 5560}"   # one adb port per client
SMP="${SMP:-8}"
MEM="${MEM:-8192}"
RENDER_NODE="${RENDER_NODE:-/dev/dri/renderD128}"

FW=""
for p in "$SSH_PORT" $PORTS; do
  tgt=$p; [ "$p" = "$SSH_PORT" ] && tgt=22
  FW="$FW,hostfwd=tcp:127.0.0.1:$p-:$tgt"
done

pkill -f 'qemu-system-x86_64 -name android-mc-gues[t]' 2>/dev/null || true
sleep 2
rm -f "$VM_DIR/qemu.pid"

setsid qemu-system-x86_64 -name android-mc-guest \
  -enable-kvm -cpu host -smp "$SMP" -m "$MEM" \
  -drive file="$DISK",if=virtio,cache=writeback \
  -drive file="$SEED",if=virtio,format=raw,readonly=on \
  -netdev "user,id=n0$FW" -device virtio-net-pci,netdev=n0 \
  -vga none -device virtio-gpu-gl-pci,hostmem=1024M \
  -display "egl-headless,rendernode=$RENDER_NODE" \
  -serial file:"$VM_DIR/serial.log" -pidfile "$VM_DIR/qemu.pid" -daemonize

echo "qemu pid=$(cat "$VM_DIR/qemu.pid")  forwards=$FW"
