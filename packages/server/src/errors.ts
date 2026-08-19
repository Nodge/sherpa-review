/** A live server for the same PR already holds the manifest, so a second process must not start (spec §1/C2). */
export class ServerAlreadyRunningError extends Error {
    readonly prKey: string;
    readonly port: number;
    readonly pid: number;

    constructor(details: { prKey: string; port: number; pid: number }) {
        super(
            `A Sherpa server for PR ${details.prKey} is already running: PID ${String(details.pid)}, ` +
                `port ${String(details.port)}. A second server for the same PR cannot start.`,
        );
        this.name = 'ServerAlreadyRunningError';
        this.prKey = details.prKey;
        this.port = details.port;
        this.pid = details.pid;
    }
}
