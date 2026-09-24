# DeepElement GCS

A web-based MAVLink ground control station for ArduPilot vehicles. A Node.js backend
talks MAVLink over UDP and serves a browser dashboard with telemetry, flight commands,
missions and audible alarms.

## Quick start

```bash
npm install
npm run dev        # GCS at http://localhost:8080, listening for MAVLink on UDP 14550
npm run sim        # optional: simulated ArduCopter (second terminal)
```

Point a vehicle, SITL or mavlink-router at UDP port 14550 on this machine. Replies go
back to whichever address the telemetry comes from. You can also set a fixed remote
host and port in the Connection panel.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GCS_HTTP_PORT` | `8080` | Port for the dashboard and API |
| `GCS_MAVLINK_PORT` | `14550` | UDP port to listen on for MAVLink |
| `GCS_AUTOCONNECT` | on | Set to `0` to not listen until connected from the UI |

`npm run sim -- <port> <drain>` sends to another port, or drains the battery faster
(in %/s while armed) to trigger the battery alarms.

## Features

- Telemetry: attitude, position, GPS, battery, HUD values, home, autopilot messages
- Commands: arm/disarm, flight mode, takeoff, land, return to launch
- Mission: download, upload (waypoints as JSON), clear
- Alarms: link lost, battery low/critical, GPS fix lost, vehicle failsafe, critical
  autopilot messages. Each plays an alert tone, then a spoken message, and repeats
  until acknowledged. See [frontend/audio/README.md](frontend/audio/README.md) for
  the sound files.

## API

REST under `/api`: `GET state`, `GET modes`, `POST|DELETE connection`,
`POST commands/{arm,disarm,mode,takeoff,land,rtl}`, `GET mission`,
`POST mission/{download,upload}`, `DELETE mission`, `GET alarms`, `GET alarms/catalog`,
`POST alarms/ack`, `POST alarms/:id/ack`.

WebSocket at `/ws` pushes `snapshot`, `state` (up to 10 Hz), `alarms` and `statustext`
messages.

## Development

```bash
npm test           # unit tests + end-to-end tests against the simulator
npm run typecheck
npm run build && npm start
```
