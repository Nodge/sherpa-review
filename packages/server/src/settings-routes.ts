import { UI_ENDPOINTS, uiSettingsPatchSchema, uiSettingsResponseSchema } from '@sherpa/protocol';

import type { Route } from './http.js';
import { handlingRpcFailures } from './http.js';
import { readRequest, respond } from './review-routes.js';
import type { SettingsStore } from './settings-store.js';

export interface SettingsRoutesOptions {
    readonly settings: SettingsStore;
}

/**
 * Global UI settings endpoints (M3-T16). They need no review host: settings are local and shared
 * by all PRs. PATCH returns the entire merged result. The second tab catches up with the first
 * when it reads the endpoint again.
 */
export function createSettingsRoutes(options: SettingsRoutesOptions): Route[] {
    return [
        {
            method: 'GET',
            path: UI_ENDPOINTS.settings,
            handle: handlingRpcFailures(() =>
                respond(uiSettingsResponseSchema, { settings: options.settings.read() }, 'local'),
            ),
        },
        {
            method: 'PATCH',
            path: UI_ENDPOINTS.settings,
            handle: handlingRpcFailures(async (ctx) => {
                const patch = await readRequest(ctx, uiSettingsPatchSchema, 'settings change');
                const settings = options.settings.patch(patch);
                return respond(uiSettingsResponseSchema, { settings }, 'local');
            }),
        },
    ];
}
