import { MavLinkPacketRegistry, minimal, common, ardupilotmega } from "node-mavlink";

export const REGISTRY: MavLinkPacketRegistry = {
  ...minimal.REGISTRY,
  ...common.REGISTRY,
  ...ardupilotmega.REGISTRY,
};
