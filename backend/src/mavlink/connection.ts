import { createSocket, RemoteInfo, Socket } from "dgram";
import { PassThrough } from "stream";
import {
  MavLinkPacket,
  MavLinkPacketParser,
  MavLinkPacketRegistry,
  MavLinkPacketSplitter,
  MavLinkProtocolV2,
  MavLinkData,
  minimal,
  common,
  ardupilotmega,
} from "node-mavlink";
import { ConnectOptions } from "../types";
import { VehicleStateStore } from "./state";

const REGISTRY: MavLinkPacketRegistry = {
  ...minimal.REGISTRY,
  ...common.REGISTRY,
  ...ardupilotmega.REGISTRY,
};

// Identity of this GCS on the MAVLink network (same convention as Mission Planner / QGC).
export const GCS_SYSTEM_ID = 255;
export const GCS_COMPONENT_ID = 190;

export const DEFAULT_LISTEN_PORT = 14550;
const HEARTBEAT_STALE_MS = 5000;
const GCS_HEARTBEAT_INTERVAL_MS = 1000;

export class MavlinkConnection {
  private socket: Socket | null = null;
  private input: PassThrough | null = null;
  private remote: { address: string; port: number } | null = null;
  private fixedRemote = false;
  private seq = 0;
  private timers: NodeJS.Timeout[] = [];

  constructor(public readonly store: VehicleStateStore) {}

  get isOpen(): boolean {
    return this.socket !== null;
  }

  get target(): { sysId: number; compId: number } {
    const { sysId, compId } = this.store.state.connection;
    return { sysId: sysId ?? 1, compId: compId ?? 1 };
  }

  async connect(opts: ConnectOptions = {}): Promise<void> {
    await this.disconnect();

    const listenPort = opts.listenPort ?? DEFAULT_LISTEN_PORT;
    this.fixedRemote = Boolean(opts.remoteHost && opts.remotePort);
    this.remote = this.fixedRemote ? { address: opts.remoteHost!, port: opts.remotePort! } : null;
    this.store.setConnecting(listenPort, this.remote);

    const input = new PassThrough();
    const reader = input.pipe(new MavLinkPacketSplitter()).pipe(new MavLinkPacketParser());
    reader.on("data", (packet: MavLinkPacket) => this.handlePacket(packet));
    this.input = input;

    const socket = createSocket({ type: "udp4", reuseAddr: true });
    socket.on("message", (buf: Buffer, rinfo: RemoteInfo) => {
      if (!this.fixedRemote) {
        this.remote = { address: rinfo.address, port: rinfo.port };
      }
      input.write(buf);
    });
    socket.on("error", (err) => {
      this.store.setError(err.message);
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(listenPort, () => {
        socket.off("error", reject);
        resolve();
      });
    }).catch((err: Error) => {
      socket.close();
      this.input = null;
      this.store.setError(`Cannot listen on UDP ${listenPort}: ${err.message}`);
      throw err;
    });

    this.socket = socket;

    this.timers.push(
      setInterval(() => this.sendGcsHeartbeat(), GCS_HEARTBEAT_INTERVAL_MS),
      setInterval(() => this.checkStale(), 1000)
    );
  }

  async disconnect(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    this.input?.end();
    this.input = null;
    this.remote = null;
    this.store.markClosed();
  }

  async send(msg: MavLinkData): Promise<void> {
    if (!this.socket || !this.remote) {
      throw new Error("No vehicle link: waiting for telemetry");
    }
    const protocol = new MavLinkProtocolV2(GCS_SYSTEM_ID, GCS_COMPONENT_ID);
    const buffer = protocol.serialize(msg, this.seq);
    this.seq = (this.seq + 1) & 255;
    const { address, port } = this.remote;
    await new Promise<void>((resolve, reject) => {
      this.socket!.send(buffer, port, address, (err) => (err ? reject(err) : resolve()));
    });
  }

  private handlePacket(packet: MavLinkPacket) {
    // Ignore echoes of our own traffic (e.g. when routed through mavlink-router).
    if (packet.header.sysid === GCS_SYSTEM_ID) return;
    const clazz = REGISTRY[packet.header.msgid];
    if (!clazz) return;
    let data: unknown;
    try {
      data = packet.protocol.data(packet.payload, clazz);
    } catch {
      return;
    }
    const remote = this.remote ? `${this.remote.address}:${this.remote.port}` : null;
    this.store.applyMessage(packet.header.msgid, packet.header.sysid, packet.header.compid, data, remote);
  }

  private sendGcsHeartbeat() {
    if (!this.remote) return;
    const hb = new minimal.Heartbeat();
    hb.type = minimal.MavType.GCS;
    hb.autopilot = minimal.MavAutopilot.INVALID;
    hb.baseMode = 0 as minimal.MavModeFlag;
    hb.customMode = 0;
    hb.systemStatus = minimal.MavState.ACTIVE;
    this.send(hb).catch(() => undefined);
  }

  private checkStale() {
    const last = this.store.state.connection.lastHeartbeatAt;
    if (last && this.store.state.connection.connected && Date.now() - last > HEARTBEAT_STALE_MS) {
      this.store.markLinkLost();
    }
  }
}
