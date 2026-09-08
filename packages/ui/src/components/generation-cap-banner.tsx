import type { UiGenerationCap } from '@sherpa/protocol';

import { useT } from '../i18n/index.js';
import './generation-cap-banner.css';

/**
 * Generation limit banner (docs/design/SPEC-elements.md §4.1). The payload budget dropped
 * non-generated files from the agent context, so the plan uses a partial diff and must say so.
 *
 * No actions. Regeneration would change nothing (the budget is the same). The only useful action is
 * to finish reading those files in the full diff, linked from the text. Lowest priority in the slot
 * (`BANNER_PRIORITY`). This is a condition of the plan, not news that needs a response.
 */

/** Files the model did not see, everything that did not fit minus the generated group. */
export function generationCapMissingFiles(cap: UiGenerationCap): number {
    return Math.max(cap.filesTotal - cap.filesCovered - cap.machineFiles, 0);
}

export function generationCapBannerVisible(cap: UiGenerationCap | null): boolean {
    return cap?.truncated === true;
}

export function GenerationCapBanner({ cap }: { readonly cap: UiGenerationCap }) {
    const t = useT();
    return (
        <div className="generation-cap-banner" role="status">
            <span className="generation-cap-banner__dot" aria-hidden="true" />
            <span className="generation-cap-banner__text">
                {t('banner.generationCap', generationCapMissingFiles(cap))}
            </span>
        </div>
    );
}
