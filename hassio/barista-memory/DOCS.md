# Barista Memory

A durable shot archive for a GaggiMate espresso machine, with the beans and
grind in force at the time of each shot, how warm the machine really was, and
maintenance reminders. The machine itself keeps only its last 100 shots and
loses them on a firmware update; this add-on keeps all of them.

## Setup

1. Find the machine's IP address on its display (or in your router).
2. Enter it under **Configuration → Machine IP address** and save.
3. Start the add-on. It appears in the sidebar as **Barista Memory**.

The archive lives in the add-on's data directory and is included in Home
Assistant backups.

## Options

- **Machine IP address** — required. Use the IP, not `gaggimate.local`; the
  add-on's container cannot resolve mDNS names.
- **Poll interval** — seconds between archive passes (default 30).
- **Write context back to the machine** — stores bean, dose, grind and ratio
  in the machine's own shot notes, so the machine's UI shows them too.

## Direct access

The web UI is reached through Home Assistant (ingress), which gives it Home
Assistant's login. If you map port 8080 in the network section it is also
reachable directly on your LAN, without any login — do not expose that port
to the internet.
