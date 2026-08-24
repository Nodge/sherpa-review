import { CommandBox } from './command-box.tsx';
import { reconnectCommand } from './reconnect-command.js';
import './disconnected-banner.css';

/** Disconnected agent condition banner. Disappears only when the worker responds again. */
export function DisconnectedBanner({ prKey }: { prKey: string }) {
    return (
        <div className="disconnected-banner" role="region" aria-label="Agent disconnected">
            <span className="disconnected-banner__dot" aria-hidden="true" />
            <div className="disconnected-banner__body">
                <div className="disconnected-banner__title">Agent disconnected.</div>
                <div className="disconnected-banner__text">
                    The reader is fully functional. Diff, search, comments and ship are available. AI areas remain
                    read-only.
                </div>
            </div>
            <CommandBox
                command={reconnectCommand(prKey)}
                hint="Run in any harness to reconnect this session as a worker."
                actionLabel="Copy command"
            />
        </div>
    );
}
