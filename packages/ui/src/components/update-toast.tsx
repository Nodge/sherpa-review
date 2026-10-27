import type { UiUpdate } from '@sherpa/protocol';
import { useEffect, useRef, useState } from 'react';

import { useT } from '../i18n/index.js';
import { CommandBox } from './command-box.tsx';
import './update-toast.css';

/**
 * "New version available" toast: bottom left corner, on the same line
 * as the floating bar. Notification only. Sherpa downloads or installs nothing, and tells you
 * which command to use to update.
 */

export interface UpdateToastProps {
    readonly update: UiUpdate;
    /** "Don't remind me about X": the version goes into global settings and the server stops returning it. */
    readonly onDismissVersion: () => void;
    /** "Later", close button and Esc: hide the toast until a reload or a click on the top bar version. */
    readonly onLater: () => void;
    /** Gallery: "How to update" starts expanded. */
    readonly howToOpen?: boolean;
    /** Gallery: no entrance animation, so the screenshot is deterministic. */
    readonly noMotion?: boolean;
}

export function UpdateToast({ update, onDismissVersion, onLater, howToOpen = false, noMotion = false }: UpdateToastProps) {
    const t = useT();
    const [how, setHow] = useState(howToOpen);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const later = useRef(onLater);
    useEffect(() => {
        later.current = onLater;
    });

    // Esc closes the toast only while focus is inside it. Globally this key belongs to
    // modal layers, so the toast must not intercept it from the palette or composer.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            const root = rootRef.current;
            if (event.key !== 'Escape' || root === null) {
                return;
            }
            if (document.activeElement !== null && root.contains(document.activeElement)) {
                later.current();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
        };
    }, []);

    return (
        <div
            ref={rootRef}
            className={`update-toast${noMotion ? ' update-toast--no-motion' : ''}`}
            role="status"
            aria-live="polite"
        >
            <div className="update-toast__head">
                <span className="update-toast__kicker">{t('update.kicker')}</span>
                <button
                    type="button"
                    className="ctl ctl--chevron update-toast__close"
                    aria-label={t('update.later')}
                    onClick={onLater}
                >
                    <span aria-hidden="true">×</span>
                </button>
            </div>

            <div className="update-toast__title">
                {t('update.title', update.latest)}
                <span className="update-toast__current">{t('update.current', update.current)}</span>
            </div>

            {update.whatsNew === null ? null : <p className="update-toast__body">{update.whatsNew}</p>}

            <div className="update-toast__footer">
                <button
                    type="button"
                    className="ctl ctl--ghost ctl--topbar update-toast__how"
                    aria-expanded={how}
                    onClick={() => {
                        setHow((open) => !open);
                    }}
                >
                    {t('update.how')}
                </button>
                <button type="button" className="ctl ctl--link-muted update-toast__dismiss" onClick={onDismissVersion}>
                    {t('update.dismiss', update.latest)}
                </button>
            </div>

            {how ? <UpdateInstructions install={update.install} /> : null}
        </div>
    );
}

/** Use the channel's command if present, otherwise the installation directory and instructions link if provided. */
function UpdateInstructions({ install }: { install: UiUpdate['install'] }) {
    const t = useT();
    if (install.command !== null) {
        return (
            <div className="update-toast__how-block">
                <CommandBox command={install.command} inputLabel={t('update.command.aria')} />
            </div>
        );
    }
    return (
        <div className="update-toast__how-block">
            {install.dir === null ? null : <p className="update-toast__copy-dir">{t('update.copyDir', install.dir)}</p>}
            {install.readmeUrl === null ? null : (
                <a className="update-toast__readme" href={install.readmeUrl} target="_blank" rel="noreferrer">
                    {t('update.readme')}
                </a>
            )}
        </div>
    );
}
