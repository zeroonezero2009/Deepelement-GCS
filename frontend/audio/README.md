# Alarm audio

Put the numbered alarm sound files here (`14` to `18`, as `.wav`, `.mp3` or `.ogg`).
`manifest.json` says how they are used:

- `files`: each numbered sound and the file names tried for it, in order.
- `tones`: the alert tone for each severity (`warning`, `critical`). It plays first.
- `speech`: the speech clip for each alarm. It plays after the tone.
  `null` means no clip yet: the browser reads the alarm title aloud instead (`tts`).
- `repeat`: how often an unacknowledged alarm repeats, and whether the speech repeats too.

Missing tone files fall back to generated beeps, so alarms are never silent.

To check which file is which, open the Audio panel in the GCS, press "Enable audio",
and use the play buttons. Each file is listed as stereo or mono.

Alarm IDs: `LINK_LOST`, `BATTERY_LOW`, `BATTERY_CRITICAL`, `GPS_FIX_LOST`,
`VEHICLE_FAILSAFE`, `AUTOPILOT_CRITICAL`.
