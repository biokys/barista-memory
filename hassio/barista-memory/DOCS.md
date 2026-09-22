# Barista Memory

A durable shot archive for a GaggiMate espresso machine, with the beans and
grind in force at the time of each shot, how warm the machine really was, and
maintenance reminders. The add-on keeps every shot in its own database,
included in Home Assistant backups.

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

## Home Assistant entities (MQTT)

With the Mosquitto broker add-on installed nothing needs configuring: the
add-on gets the broker from the Supervisor and Home Assistant discovers a
**Barista Memory** device with these entities:

- **Machine warm-up** (%) and **Machine ready** (on once the warm-up model
  says the group is hot, default 85 %, with hysteresis so it does not flap)
- **Boiler temperature**, **Target temperature**, **Heating for**
- **Machine mode** as a sensor and as a select that switches the machine
  between standby, brew, steam and hot water
- **Machine on**, **Last shot** (with bean, ratio, weight and rating as
  attributes), **Maintenance due** and **Shots since backflush**

A notification when the machine is ready is then one automation: trigger on
`binary_sensor.barista_memory_ready` turning on, action "notify".

Another broker can be set under Configuration instead.

## Receipt printer

A Bluetooth thermal printer of the MXW01 family ("cat printer") can print a
receipt after every coffee: facts, the pressure and flow curve, rating, a
greeting and a QR code to the shot. The add-on reaches it through the host's
Bluetooth (BlueZ), so the Home Assistant machine needs a Bluetooth adapter
in range of the printer.

Everything about it lives on the **Settings** page of the web UI: find the
printer, test, switch on "print every shot", set the café name, language
and greetings. A **Print last shot** button entity appears in Home Assistant
as well, for automations.

## AI assistants (MCP)

The archive can be a tool for Claude Code, Claude Desktop and other MCP
clients: shots with their context, machine state, maintenance, profiles.

1. Set **MCP token** under Configuration to a long random string.
2. Map port 8080 in the Network section (the endpoint is on the web port).
3. On your computer, on the same network or VPN:

```
claude mcp add barista-memory --transport http http://<home-assistant-ip>:8080/mcp \
  --header "Authorization: Bearer <your token>"
```

Clients that only speak stdio can use a local bridge such as `mcp-remote`
with the same URL and header. The endpoint is never reachable through
ingress and must not be exposed to the internet.

## Direct access

The web UI is reached through Home Assistant (ingress), which gives it Home
Assistant's login. If you map port 8080 in the network section it is also
reachable directly on your LAN, without any login — do not expose that port
to the internet.
