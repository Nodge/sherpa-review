/** Command for a new harness session to connect to the current PR. */
export function reconnectCommand(prKey: string): string {
    return `/sherpa-review ${prKey}`;
}
