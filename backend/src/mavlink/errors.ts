/** No vehicle has been heard yet, so there is nowhere to send to. */
export class NoLinkError extends Error {
  constructor() {
    super("No vehicle link: waiting for telemetry");
    this.name = "NoLinkError";
  }
}

/** The request is invalid for the connected vehicle (e.g. unknown flight mode). */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

/** A conflicting operation (e.g. another mission transfer) is already running. */
export class BusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusyError";
  }
}
