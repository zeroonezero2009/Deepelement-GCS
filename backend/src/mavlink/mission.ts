import { common, minimal } from "node-mavlink";
import { MissionItemInput, MissionWaypoint } from "../types";
import { MavlinkConnection } from "./connection";
import { BusyError } from "./errors";
import { sendAndWait, TimeoutError, withRetries } from "./wait";

type MissionItemInt = InstanceType<typeof common.MissionItemInt>;
type MissionCount = InstanceType<typeof common.MissionCount>;
type MissionAck = InstanceType<typeof common.MissionAck>;
type MissionRequest = InstanceType<typeof common.MissionRequestInt>;

const STEP_TIMEOUT_MS = 1500;
const RETRIES = 3;
const MISSION = common.MavMissionType.MISSION;

export function toWaypoint(item: MissionItemInt): MissionWaypoint {
  return {
    seq: item.seq,
    lat: item.x / 1e7,
    lon: item.y / 1e7,
    altM: item.z,
    command: item.command,
    frame: item.frame,
    current: item.current === 1,
    autocontinue: item.autocontinue === 1,
    params: [item.param1, item.param2, item.param3, item.param4],
  };
}

export class MissionService {
  private busy = false;

  constructor(private readonly link: MavlinkConnection) {}

  /** Reads the full mission from the vehicle and stores it in the state store. */
  download(): Promise<MissionWaypoint[]> {
    return this.exclusive(async () => {
      const store = this.link.store;
      const count = await withRetries(RETRIES, () =>
        sendAndWait<MissionCount>(
          store,
          "missionCount",
          (c) => c.missionType === MISSION,
          STEP_TIMEOUT_MS,
          () => this.link.send(this.requestList()),
          "Vehicle did not answer MISSION_REQUEST_LIST"
        )
      ).then((c) => c.count);

      const waypoints: MissionWaypoint[] = [];
      for (let seq = 0; seq < count; seq++) {
        const item = await withRetries(RETRIES, () =>
          sendAndWait<MissionItemInt>(
            store,
            "missionItem",
            (i) => i.seq === seq && i.missionType === MISSION,
            STEP_TIMEOUT_MS,
            () => this.link.send(this.requestItem(seq)),
            `Vehicle did not send mission item ${seq}`
          )
        );
        waypoints.push(toWaypoint(item));
      }

      await this.link.send(this.ack(common.MavMissionResult.ACCEPTED));
      store.setMission(waypoints);
      return waypoints;
    });
  }

  /**
   * Uploads a mission. For ArduPilot, item 0 is the home position; it is added
   * automatically from the vehicle's home (or the first item) so callers only pass waypoints.
   */
  upload(inputs: MissionItemInput[]): Promise<MissionWaypoint[]> {
    return this.exclusive(async () => {
      if (inputs.length === 0) {
        await this.clearUnlocked();
        return [];
      }
      const items = this.buildItems(inputs);
      await this.runUpload(items);
      const waypoints = items.map(toWaypoint);
      this.link.store.setMission(waypoints);
      return waypoints;
    });
  }

  clear(): Promise<void> {
    return this.exclusive(() => this.clearUnlocked());
  }

  private async clearUnlocked() {
    const store = this.link.store;
    const ack = await withRetries(RETRIES, () =>
      sendAndWait<MissionAck>(
        store,
        "missionAck",
        (a) => a.missionType === MISSION,
        STEP_TIMEOUT_MS,
        () => this.link.send(this.clearAll()),
        "Vehicle did not acknowledge MISSION_CLEAR_ALL"
      )
    );
    if (ack.type !== common.MavMissionResult.ACCEPTED) {
      throw new Error(`Mission clear rejected: ${common.MavMissionResult[ack.type] ?? ack.type}`);
    }
    store.setMission([]);
  }

  private runUpload(items: MissionItemInt[]): Promise<void> {
    const store = this.link.store;
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      let countAttempts = 0;
      let requestSeen = false;

      const cleanup = () => {
        clearTimeout(timer);
        store.off("missionRequest", onRequest);
        store.off("missionAck", onAck);
      };
      const fail = (err: Error) => {
        cleanup();
        reject(err);
      };
      const armTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(onTimeout, STEP_TIMEOUT_MS);
      };
      const sendCount = () => {
        countAttempts++;
        this.link.send(this.count(items.length)).catch(fail);
        armTimer();
      };
      const onTimeout = () => {
        // Until the vehicle starts requesting items, MISSION_COUNT itself may have been lost.
        if (!requestSeen && countAttempts < RETRIES) {
          sendCount();
          return;
        }
        fail(new TimeoutError("Mission upload stalled: vehicle stopped requesting items"));
      };
      const onRequest = (req: MissionRequest) => {
        if (req.missionType !== MISSION) return;
        const item = items[req.seq];
        if (!item) return;
        requestSeen = true;
        this.link.send(item).catch(fail);
        armTimer();
      };
      const onAck = (ack: MissionAck) => {
        if (ack.missionType !== MISSION) return;
        // A stray ACK from an earlier transfer can arrive before our first request.
        if (!requestSeen && ack.type === common.MavMissionResult.ACCEPTED) return;
        cleanup();
        if (ack.type === common.MavMissionResult.ACCEPTED) {
          resolve();
        } else {
          reject(new Error(`Mission upload rejected: ${common.MavMissionResult[ack.type] ?? ack.type}`));
        }
      };

      store.on("missionRequest", onRequest);
      store.on("missionAck", onAck);
      sendCount();
    });
  }

  private buildItems(inputs: MissionItemInput[]): MissionItemInt[] {
    const { state } = this.link.store;
    const withHome = state.heartbeat?.autopilot === minimal.MavAutopilot.ARDUPILOTMEGA;
    const all: MissionItemInput[] = [...inputs];
    if (withHome) {
      const home = state.home ?? { lat: inputs[0].lat, lon: inputs[0].lon, altMslM: 0 };
      all.unshift({
        lat: home.lat,
        lon: home.lon,
        altM: home.altMslM,
        command: common.MavCmd.NAV_WAYPOINT,
        frame: common.MavFrame.GLOBAL,
      });
    }
    return all.map((input, seq) => {
      const item = new common.MissionItemInt();
      const { sysId, compId } = this.link.target;
      item.targetSystem = sysId;
      item.targetComponent = compId;
      item.seq = seq;
      item.frame = (input.frame ?? common.MavFrame.GLOBAL_RELATIVE_ALT_INT) as common.MavFrame;
      item.command = (input.command ?? common.MavCmd.NAV_WAYPOINT) as common.MavCmd;
      item.current = seq === 0 ? 1 : 0;
      item.autocontinue = 1;
      const [p1, p2, p3, p4] = input.params ?? [0, 0, 0, 0];
      item.param1 = p1;
      item.param2 = p2;
      item.param3 = p3;
      item.param4 = p4;
      item.x = Math.round(input.lat * 1e7);
      item.y = Math.round(input.lon * 1e7);
      item.z = input.altM;
      item.missionType = MISSION;
      return item;
    });
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new BusyError("Another mission transfer is in progress");
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  private requestList() {
    const msg = new common.MissionRequestList();
    this.address(msg);
    msg.missionType = MISSION;
    return msg;
  }

  private requestItem(seq: number) {
    const msg = new common.MissionRequestInt();
    this.address(msg);
    msg.seq = seq;
    msg.missionType = MISSION;
    return msg;
  }

  private count(count: number) {
    const msg = new common.MissionCount();
    this.address(msg);
    msg.count = count;
    msg.missionType = MISSION;
    return msg;
  }

  private clearAll() {
    const msg = new common.MissionClearAll();
    this.address(msg);
    msg.missionType = MISSION;
    return msg;
  }

  private ack(result: common.MavMissionResult) {
    const msg = new common.MissionAck();
    this.address(msg);
    msg.type = result;
    msg.missionType = MISSION;
    return msg;
  }

  private address(msg: { targetSystem: number; targetComponent: number }) {
    const { sysId, compId } = this.link.target;
    msg.targetSystem = sysId;
    msg.targetComponent = compId;
  }
}
