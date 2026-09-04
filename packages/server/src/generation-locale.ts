import type { Locale, LocaleSetting } from '@sherpa/protocol';

/**
 * Generation language (M5, task breakdown decision 2): the model uses it for routes and chat answers. It is also
 * stored in snapshot `provenance.locale` and used for server strings the reviewer sees alongside them.
 *
 * Resolution follows the UI language order, with one difference: the UI knows the browser language, but the server
 * does not, so it falls back to English. The tab therefore sends its effective locale
 * in the request, and the order below applies where no one can be asked: warmup automatically enqueuing a skeleton
 * and old clients without the field.
 */
export function resolveGenerationLocale(input: {
    /** Locale specified by the UI request. `undefined` means the server initiated generation. */
    readonly requested?: Locale | undefined;
    /** `settings.locale`: `auto` means no choice was made, so the agent hint decides. */
    readonly setting?: LocaleSetting | undefined;
    /** `worker.lang`: the language the user speaks with the agent. */
    readonly agentLang?: Locale | undefined;
}): Locale {
    if (input.requested !== undefined) {
        return input.requested;
    }
    if (input.setting !== undefined && input.setting !== 'auto') {
        return input.setting;
    }
    return input.agentLang ?? 'en';
}
