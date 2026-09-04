import type { Locale } from '@sherpa/protocol';

/**
 * Server strings stored in the snapshot and read by the reviewer (M5-T4): the synthetic stop
 * title, validator notes and reasons generation failed. They belong to the route,
 * so they use the generation language, not the tab's language. Each snapshot uses one language throughout.
 *
 * The entire small table lives here. Two dozen strings don't warrant a localization
 * framework (task breakdown decision 1: the UI dictionary is also local). Logs and stderr do not belong here:
 * developers read them, not the reviewer.
 */
export interface RouteStrings {
    /** Synthetic stop title. The server adds this stop, and the model doesn't know about it. */
    readonly otherStopTitle: string;
    /** The anchor points to a file absent from the diff. */
    anchorFileMissing(path: string): string;
    /** The anchor points to lines untouched by the change. */
    anchorNotChanged(path: string, span: string): string;
    /** A stop submitted earlier has taken the entire range. */
    rangeTaken(path: string, span: string, stopLabel: string): string;
    /** A stop submitted earlier has taken part of the range. */
    rangeTrimmed(path: string, span: string, stopLabel: string): string;
    /** Digest claims whose anchors point to files outside the diff. */
    claimsMissingFiles(paths: readonly string[]): string;
    /** Digest claims without a test anchor. */
    claimsAnchorless(count: number): string;
    /** A change reason on a stop untouched by the push. */
    readonly changeReasonDropped: string;
    /** A reference to a thread the server hasn't fetched. */
    unknownThread(id: string): string;
    /** Stop filling was cancelled along with its task. */
    readonly stopFillCancelled: string;
    /** The filling task failed. `reason` is the reason the agent gave. */
    stopFillFailed(reason: string | null): string;
    /** The task completed successfully, but the slot is still empty. */
    readonly stopMissingInResult: string;
    /** The skeleton wasn't built. `reason` is the reason the agent gave. */
    skeletonFailed(reason: string): string;
    /** The skeleton was accepted, but its result could never be applied. */
    skeletonNotApplied(attempts: number): string;
    /** The patch for the iteration used to build the route is no longer available. */
    lostDiff(diffId: string): string;
}

const RU: RouteStrings = {
    otherStopTitle: 'Прочее — модель не разместила эти строки',
    anchorFileMissing: (path) => `Якорь на \`${path}\` отброшен: файла нет в этом диффе.`,
    anchorNotChanged: (path, span) =>
        `Якорь на \`${path}\` (строки ${span}) отброшен: в этом диапазоне ничего не менялось.`,
    rangeTaken: (path, span, stopLabel) => `Диапазон \`${path}\` ${span} уже объяснён в стопе ${stopLabel}.`,
    rangeTrimmed: (path, span, stopLabel) =>
        `Часть диапазона \`${path}\` ${span} уже объяснена в стопе ${stopLabel} — якорь урезан.`,
    claimsMissingFiles: (paths) => {
        const unique = [...new Set(paths)];
        const list = unique.map((path) => `\`${path}\``).join(', ');
        const lead = unique.length === 1 ? 'якорь вёл в' : 'якоря вели в';
        const tail = unique.length === 1 ? 'которого нет в этом диффе' : 'этих файлов нет в этом диффе';
        return `${droppedClaimsPrefixRu(paths.length)}: ${lead} ${list}, ${tail}.`;
    },
    claimsAnchorless: (count) => `${droppedClaimsPrefixRu(count)}: якорь на тест не указан.`,
    changeReasonDropped: 'Причина изменения отброшена: остановка не менялась с прошлого захода.',
    unknownThread: (id) => `Ссылка на неизвестный тред ${id} удалена.`,
    stopFillCancelled: 'Заполнение этой остановки отменено.',
    stopFillFailed: (reason) =>
        `Остановка осталась незаполненной: ${reason ?? 'агент не назвал причину'}`,
    stopMissingInResult: 'Агент сдал результат без этой остановки — слот остался незаполненным.',
    skeletonFailed: (reason) =>
        reason === ''
            ? 'Агент не построил план маршрута и не назвал причину.'
            : `Агент не построил план маршрута: ${reason}`,
    skeletonNotApplied: (attempts) =>
        `Маршрут не собрался: сервер ${String(attempts)} раза ставил задачу на план и ни разу не смог ` +
        'применить её результат.',
    lostDiff: (diffId) =>
        `Дифф итерации ${diffId}, на которой построен этот маршрут, недоступен: хост её больше ` +
        'не отдаёт, а локальной копии нет. Постройте маршрут заново.',
};

const EN: RouteStrings = {
    otherStopTitle: 'Other — lines the model did not place',
    anchorFileMissing: (path) => `Anchor on \`${path}\` dropped: the file is not in this diff.`,
    anchorNotChanged: (path, span) =>
        `Anchor on \`${path}\` (lines ${span}) dropped: nothing changed in that range.`,
    rangeTaken: (path, span, stopLabel) => `Range \`${path}\` ${span} is already explained by stop ${stopLabel}.`,
    rangeTrimmed: (path, span, stopLabel) =>
        `Part of range \`${path}\` ${span} is already explained by stop ${stopLabel} — the anchor was trimmed.`,
    claimsMissingFiles: (paths) => {
        const unique = [...new Set(paths)];
        const list = unique.map((path) => `\`${path}\``).join(', ');
        const tail =
            unique.length === 1
                ? `the anchor pointed at ${list}, which is not in this diff`
                : `the anchors pointed at ${list}, and those files are not in this diff`;
        return `${droppedClaimsPrefixEn(paths.length)}: ${tail}.`;
    },
    claimsAnchorless: (count) => `${droppedClaimsPrefixEn(count)}: no test anchor given.`,
    changeReasonDropped: 'Change reason dropped: this stop did not move since the previous route.',
    unknownThread: (id) => `Link to unknown thread ${id} removed.`,
    stopFillCancelled: 'Filling of this stop was cancelled.',
    stopFillFailed: (reason) => `The stop was left unfilled: ${reason ?? 'the agent named no reason'}`,
    stopMissingInResult: 'The agent returned a result without this stop — the slot stayed empty.',
    skeletonFailed: (reason) =>
        reason === ''
            ? 'The agent did not plan the route and named no reason.'
            : `The agent did not plan the route: ${reason}`,
    skeletonNotApplied: (attempts) =>
        `The route did not come together: the server queued the plan ${String(attempts)} times and never ` +
        'managed to apply the result.',
    lostDiff: (diffId) =>
        `The diff of iteration ${diffId}, the one this route was built on, is gone: the host no longer ` +
        'serves it and there is no local copy left. Build the route again.',
};

const TABLE: Record<Locale, RouteStrings> = { ru: RU, en: EN };

export function routeStrings(locale: Locale): RouteStrings {
    return TABLE[locale];
}

/** Russian count wording for reviewer notes: "Two claims dropped", "7 claims dropped". */
function droppedClaimsPrefixRu(count: number): string {
    const words = ['', 'Одно', 'Два', 'Три', 'Четыре'];
    const head = words[count] ?? String(count);
    const teen = count % 100 >= 11 && count % 100 <= 14;
    const last = count % 10;
    if (!teen && last === 1) {
        return `${head} утверждение отброшено`;
    }
    if (!teen && last >= 2 && last <= 4) {
        return `${head} утверждения отброшены`;
    }
    return `${head} утверждений отброшено`;
}

function droppedClaimsPrefixEn(count: number): string {
    return count === 1 ? 'One claim dropped' : `${String(count)} claims dropped`;
}
