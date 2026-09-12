import { useT } from '../i18n/index.js';
import { useUiSettingsStore } from '../settings/context.tsx';
import { useResolvedTheme } from '../settings/document-settings.tsx';

/**
 * The label names the theme the reviewer currently sees. The accessible name and tooltip describe the action
 * on click. Clicking sets the explicit opposite theme. In `auto` mode, it chooses the opposite of the theme
 * supplied by the system.
 */
export function ThemeToggle() {
    const t = useT();
    const theme = useResolvedTheme();
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
