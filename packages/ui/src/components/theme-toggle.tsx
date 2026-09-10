import { useT } from '../i18n/index.js';
import { useUiSettings, useUiSettingsStore } from '../settings/context.tsx';

/** The label names the current theme. The accessible name and tooltip describe the click action. */
export function ThemeToggle() {
    const t = useT();
    const { theme } = useUiSettings();
    const settings = useUiSettingsStore();
    const action = t(theme === 'dark' ? 'theme.toLight' : 'theme.toDark');
    return (
        <button
            type="button"
            className="ghost-button theme-toggle"
            aria-label={action}
            title={action}
            onClick={() => {
                settings.update({ theme: theme === 'dark' ? 'light' : 'dark' });
            }}
        >
            {t(theme === 'dark' ? 'theme.dark' : 'theme.light')}
        </button>
    );
}
