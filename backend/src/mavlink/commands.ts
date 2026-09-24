import { common, minimal } from "node-mavlink";
import { MavlinkConnection } from "./connection";
import { InvalidRequestError } from "./errors";
import { modeTableForVehicle } from "./modes";
import { TimeoutError } from "./wait";

type CommandAck = InstanceType<typeof common.CommandAck>;
type Params = [number?, number?, number?, number?, number?, number?, number?];

const ACK_TIMEOUT_MS = 1500;
// Some commands (e.g. calibration, takeoff on some firmwares) report IN_PROGRESS first.
const IN_PROGRESS_TIMEOUT_MS = 10000;
const RETRIES = 3;
// Magic param2 value that makes ArduPilot/PX4 skip pre-arm / in-flight disarm checks.
const FORCE_ARM_MAGIC = 21196;

export class CommandRejectedError extends Error {
  constructor(public readonly command: common.MavCmd, public readonly result: common.MavResult) {
    super(`${common.MavCmd[command] ?? command} rejected: ${common.MavResult[result] ?? result}`);
    this.name = "CommandRejectedError";
  }
}

export class CommandService {
  constructor(private readonly link: MavlinkConnection) {}

  /** Sends COMMAND_LONG and resolves once the vehicle ACKs it as ACCEPTED. */
  async commandLong(command: common.MavCmd, params: Params = []): Promise<void> {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const msg = new common.CommandLong();
      const { sysId, compId } = this.link.target;
      msg.targetSystem = sysId;
      msg.targetComponent = compId;
      msg.command = command;
      msg.confirmation = attempt;
      msg._param1 = params[0] ?? 0;
      msg._param2 = params[1] ?? 0;
      msg._param3 = params[2] ?? 0;
      msg._param4 = params[3] ?? 0;
      msg._param5 = params[4] ?? 0;
      msg._param6 = params[5] ?? 0;
      msg._param7 = params[6] ?? 0;
      try {
        const ack = await this.sendAndAwaitFinalAck(msg);
        if (ack.result !== common.MavResult.ACCEPTED) {
          throw new CommandRejectedError(command, ack.result);
        }
        return;
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err;
      }
    }
    throw new TimeoutError(`No COMMAND_ACK for ${common.MavCmd[command] ?? command}`);
  }

  arm(force = false) {
    return this.commandLong(common.MavCmd.COMPONENT_ARM_DISARM, [1, force ? FORCE_ARM_MAGIC : 0]);
  }

  disarm(force = false) {
    return this.commandLong(common.MavCmd.COMPONENT_ARM_DISARM, [0, force ? FORCE_ARM_MAGIC : 0]);
  }

  /** Sets an ArduPilot flight mode by name, e.g. "GUIDED". */
  setMode(modeName: string) {
    const vehicleType = this.link.store.state.heartbeat?.vehicleType ?? minimal.MavType.QUADROTOR;
    const table = modeTableForVehicle(vehicleType);
    const wanted = modeName.trim().toUpperCase();
    const entry = Object.entries(table).find(([, name]) => name === wanted);
    if (!entry) {
      throw new InvalidRequestError(`Unknown mode "${modeName}" for this vehicle`);
    }
    return this.commandLong(common.MavCmd.DO_SET_MODE, [
      minimal.MavModeFlag.CUSTOM_MODE_ENABLED,
      Number(entry[0]),
    ]);
  }

  takeoff(altM: number) {
    return this.commandLong(common.MavCmd.NAV_TAKEOFF, [0, 0, 0, NaN, NaN, NaN, altM]);
  }

  land() {
    return this.commandLong(common.MavCmd.NAV_LAND, [0, 0, 0, NaN, NaN, NaN, NaN]);
  }

  returnToLaunch() {
    return this.commandLong(common.MavCmd.NAV_RETURN_TO_LAUNCH);
  }

  private sendAndAwaitFinalAck(msg: InstanceType<typeof common.CommandLong>): Promise<CommandAck> {
    const store = this.link.store;
    return new Promise<CommandAck>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const cleanup = () => {
        clearTimeout(timer);
        store.off("commandAck", onAck);
      };
      const arm = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          cleanup();
          reject(new TimeoutError(`No COMMAND_ACK for ${common.MavCmd[msg.command] ?? msg.command}`));
        }, ms);
      };
      const onAck = (ack: CommandAck) => {
        if (ack.command !== msg.command) return;
        if (ack.result === common.MavResult.IN_PROGRESS) {
          arm(IN_PROGRESS_TIMEOUT_MS);
          return;
        }
        cleanup();
        resolve(ack);
      };
      store.on("commandAck", onAck);
      arm(ACK_TIMEOUT_MS);
      this.link.send(msg).catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }
}
