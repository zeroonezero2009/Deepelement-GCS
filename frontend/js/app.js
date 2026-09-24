import { AlarmAudio } from "./alarm-audio.js";

const $ = (id) => document.getElementById(id);
const MAX_LOG = 200;
const MAV_CMD_NAMES = { 16: "WAYPOINT", 20: "RTL", 21: "LAND", 22: "TAKEOFF", 177: "JUMP", 183: "SERVO" };
const GPS_FIX = ["No GPS", "No fix", "2D", "3D", "DGPS", "RTK float", "RTK fixed", "Static", "PPP"];

let state = null;
let alarms = [];
let statusLog = [];
let modesFor = null; // vehicle type the mode list was loaded for
let renderQueued = false;

const audio = new AlarmAudio();

// --- helpers -------------------------------------------------------------------

async function api(method, path, body) {
  const res = await fetch(`api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function fmt(value, digits, unit = "") {
  return value === null || value === undefined || Number.isNaN(value) ? "—" : `${value.toFixed(digits)}${unit}`;
}

function showResult(el, promise, okText) {
  el.className = "result";
  el.textContent = "…";
  return promise
    .then((r) => {
      el.className = "result ok";
      el.textContent = okText;
      return r;
    })
    .catch((err) => {
      el.className = "result err";
      el.textContent = err.message;
    });
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

// --- rendering -----------------------------------------------------------------

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  if (!state) return;
  const { connection: c, heartbeat: hb, position: pos, vfrHud: hud, attitude: att, battery: bat, gps, home } = state;

  const link = $("link-pill");
  if (c.connected) {
    link.textContent = `Link OK · ${c.remote ?? ""}`;
    link.className = "pill pill-ok";
  } else if (c.listening && c.lastHeartbeatAt) {
    link.textContent = "Link lost";
    link.className = "pill pill-crit";
  } else if (c.listening) {
    link.textContent = `Waiting on UDP ${c.listenPort}`;
    link.className = "pill pill-off";
  } else {
    link.textContent = c.error ? "Link error" : "No link";
    link.className = c.error ? "pill pill-crit" : "pill pill-off";
  }
  $("mode-pill").textContent = hb?.flightModeName ?? "—";
  $("armed-pill").textContent = hb?.armed ? "ARMED" : "DISARMED";
  $("armed-pill").className = hb?.armed ? "pill pill-crit" : "pill";

  $("t-alt").textContent = fmt(pos?.altRelM, 1, " m");
  $("t-gs").textContent = fmt(pos?.groundSpeedMs ?? hud?.groundspeedMs, 1, " m/s");
  $("t-climb").textContent = fmt(hud?.climbMs, 1, " m/s");
  $("t-hdg").textContent = fmt(pos?.headingDeg ?? hud?.headingDeg, 0, "°");
  $("t-att").textContent = att ? `${att.rollDeg.toFixed(1)}° / ${att.pitchDeg.toFixed(1)}°` : "—";
  $("t-thr").textContent = fmt(hud?.throttlePct, 0, " %");
  $("t-bat").textContent = bat
    ? [fmt(bat.remainingPct, 0, " %"), fmt(bat.voltageV, 2, " V"), fmt(bat.currentA, 1, " A")].join(" · ")
    : "—";
  $("t-gps").textContent = gps ? `${GPS_FIX[gps.fixType] ?? gps.fixType} · ${gps.satellitesVisible} sats` : "—";
  $("t-pos").textContent = pos ? `${pos.lat.toFixed(6)}, ${pos.lon.toFixed(6)}` : "—";
  $("t-home").textContent = home ? `${home.lat.toFixed(6)}, ${home.lon.toFixed(6)}` : "—";

  $("conn-info").textContent = c.error
    ? `Error: ${c.error}`
    : c.listening
      ? `Listening on UDP ${c.listenPort}${c.sysId ? ` · vehicle sys ${c.sysId} comp ${c.compId}` : ""}`
      : "Not listening";

  renderMission();
  if (hb && hb.vehicleType !== modesFor) loadModes(hb.vehicleType);
}

function renderMission() {
  const body = $("mission-body");
  const items = state.mission;
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted">No mission loaded</td></tr>';
    return;
  }
  body.replaceChildren(
    ...items.map((w) => {
      const tr = document.createElement("tr");
      for (const text of [
        w.seq,
        MAV_CMD_NAMES[w.command] ?? w.command,
        w.lat.toFixed(6),
        w.lon.toFixed(6),
        w.altM.toFixed(1),
      ]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    })
  );
}

function renderAlarms() {
  const bar = $("alarm-bar");
  bar.hidden = alarms.length === 0;
  $("alarm-list").replaceChildren(
    ...alarms.map((a) => {
      const li = document.createElement("li");
      li.className = `alarm alarm-${a.severity}${a.acknowledged ? "" : " unacked"}`;
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = a.title.en;
      const ar = document.createElement("span");
      ar.className = "ar";
      ar.lang = "ar";
      ar.textContent = a.title.ar;
      li.append(title, ar);
      if (a.detail) {
        const detail = document.createElement("span");
        detail.className = "detail";
        detail.textContent = a.detail;
        li.append(detail);
      }
      const age = document.createElement("span");
      age.className = "age";
      age.textContent = ago(a.raisedAt);
      li.append(age);
      if (!a.acknowledged) {
        const ack = document.createElement("button");
        ack.className = "btn";
        ack.textContent = "Acknowledge";
        ack.onclick = () => api("POST", `/alarms/${a.id}/ack`).catch((e) => console.warn(e));
        li.append(ack);
      }
      return li;
    })
  );
}

function appendStatus(entry) {
  statusLog.push(entry);
  if (statusLog.length > MAX_LOG) statusLog.shift();
  const li = document.createElement("li");
  if (entry.severity <= 2) li.className = "sev-crit";
  else if (entry.severity <= 4) li.className = "sev-warn";
  li.textContent = `${new Date(entry.timestamp).toLocaleTimeString()}  ${entry.text}`;
  const log = $("status-log");
  log.prepend(li);
  while (log.children.length > MAX_LOG) log.lastChild.remove();
}

function renderAudio(status) {
  $("audio-enable").hidden = status.unlocked;
  $("audio-mute").hidden = !status.unlocked;
  $("audio-mute").textContent = status.muted ? "Unmute" : "Mute";
  const loaded = status.files.filter((f) => f.state === "loaded").length;
  $("audio-state").textContent = !status.unlocked
    ? 'Audio is off. Press "Enable audio" to hear alarms.'
    : status.muted
      ? "Muted: alarms are shown but not played."
      : `On. ${loaded}/${status.files.length} sound files loaded; missing sounds use generated beeps and speech.`;

  const roles = {};
  for (const [sev, id] of Object.entries(audio.manifest.tones)) if (id) (roles[id] ??= []).push(`${sev} tone`);
  for (const [alarm, id] of Object.entries(audio.manifest.speech)) if (id) (roles[id] ??= []).push(alarm);

  $("sound-body").replaceChildren(
    ...status.files.map((f) => {
      const tr = document.createElement("tr");
      const cells = [
        f.id,
        roles[f.id]?.join(", ") ?? `${f.kind} (unassigned)`,
        f.state === "loaded"
          ? `${f.src} · ${f.channels === 1 ? "mono" : f.channels === 2 ? "stereo" : `${f.channels} ch`} · ${f.durationSec.toFixed(1)} s`
          : f.state,
      ];
      for (const text of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      const td = document.createElement("td");
      const play = document.createElement("button");
      play.className = "btn";
      play.textContent = "▶";
      play.setAttribute("aria-label", `Play sound ${f.id}`);
      play.disabled = f.state !== "loaded";
      play.onclick = () => audio.preview(f.id);
      td.append(play);
      tr.append(td);
      return tr;
    })
  );
}

async function loadModes(vehicleType) {
  modesFor = vehicleType;
  try {
    const modes = await api("GET", "/modes");
    const select = $("mode-select");
    const current = select.value || state?.heartbeat?.flightModeName;
    select.replaceChildren(
      ...modes.map((m) => {
        const opt = document.createElement("option");
        opt.value = opt.textContent = m.name;
        return opt;
      })
    );
    if (current) select.value = current;
  } catch {
    modesFor = null;
  }
}

// --- WebSocket -----------------------------------------------------------------

function connectWs(delay = 500) {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case "snapshot":
        state = msg.state;
        statusLog = [];
        $("status-log").replaceChildren();
        msg.state.statusLog.forEach(appendStatus);
        setAlarms(msg.alarms);
        break;
      case "state":
        state = { ...msg.state, statusLog };
        break;
      case "alarms":
        setAlarms(msg.alarms);
        break;
      case "statustext":
        appendStatus(msg.entry);
        break;
    }
    scheduleRender();
  };
  ws.onopen = () => (delay = 500);
  ws.onclose = () => {
    const link = $("link-pill");
    link.textContent = "GCS server offline";
    link.className = "pill pill-crit";
    setTimeout(() => connectWs(Math.min(delay * 2, 5000)), delay);
  };
}

function setAlarms(list) {
  alarms = list;
  renderAlarms();
  audio.update(list);
}

// --- wiring --------------------------------------------------------------------

function wire() {
  const cmd = (path, body, ok) => showResult($("cmd-result"), api("POST", path, body), ok);

  $("btn-mode").onclick = () => {
    const mode = $("mode-select").value;
    if (mode) cmd("/commands/mode", { mode }, `Mode set to ${mode}`);
  };
  $("btn-arm").onclick = () => confirm("Arm motors?") && cmd("/commands/arm", {}, "Armed");
  $("btn-disarm").onclick = () => confirm("Disarm motors?") && cmd("/commands/disarm", {}, "Disarmed");
  $("btn-takeoff").onclick = () => {
    const altM = Number($("takeoff-alt").value);
    cmd("/commands/takeoff", { altM }, `Taking off to ${altM} m`);
  };
  $("btn-land").onclick = () => cmd("/commands/land", {}, "Landing");
  $("btn-rtl").onclick = () => cmd("/commands/rtl", {}, "Returning to launch");

  const missionOut = $("mission-result");
  $("btn-mission-download").onclick = () =>
    showResult(missionOut, api("POST", "/mission/download"), "Mission downloaded");
  $("btn-mission-clear").onclick = () =>
    confirm("Clear the mission on the vehicle?") &&
    showResult(missionOut, api("DELETE", "/mission"), "Mission cleared");
  $("btn-mission-upload").onclick = () => {
    let items;
    try {
      items = JSON.parse($("mission-json").value);
    } catch (err) {
      missionOut.className = "result err";
      missionOut.textContent = `Invalid JSON: ${err.message}`;
      return;
    }
    showResult(missionOut, api("POST", "/mission/upload", { items }), `Uploaded ${items.length} waypoints`);
  };

  $("conn-form").onsubmit = (ev) => {
    ev.preventDefault();
    const body = {
      listenPort: $("conn-port").value,
      remoteHost: $("conn-host").value,
      remotePort: $("conn-rport").value,
    };
    showResult($("cmd-result"), api("POST", "/connection", body), "Connection opened");
  };
  $("btn-disconnect").onclick = () => showResult($("cmd-result"), api("DELETE", "/connection"), "Disconnected");

  $("alarm-ack-all").onclick = () => api("POST", "/alarms/ack").catch((e) => console.warn(e));

  $("audio-enable").onclick = () => audio.unlock();
  $("audio-mute").onclick = () => audio.setMuted(!audio.muted);
  $("btn-test-warning").onclick = () => audio.test("warning");
  $("btn-test-critical").onclick = () => audio.test("critical");
  audio.addEventListener("status", (ev) => renderAudio(ev.detail));

  // Keep "raised N s ago" fresh.
  setInterval(() => alarms.length && renderAlarms(), 5000);
}

wire();
audio.loadManifest();
connectWs();
