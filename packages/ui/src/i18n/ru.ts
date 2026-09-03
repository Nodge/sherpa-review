import { formatCount, plural } from './format.js';

/**
 * The Russian dictionary is the source of truth for keys: the `Dictionary` type is derived from it,
 * and the English dictionary must match every key and signature.
 *
 * A key is a flat string with a dotted prefix for the screen area (`app.`, `topbar.`, `palette.`…).
 * A value is a string or a function of parameters. Languages differ in word order and word forms,
 * so components must not assemble translations from fragments.
 */

const num = (value: number): string => formatCount(value, 'ru');
/** Russian word forms: `other` matches `many` ("5 files"). */
const form = (value: number, one: string, few: string, many: string): string =>
    plural(value, { one, few, many, other: many }, 'ru');

export const ru = {
    'app.name': 'Шерпа',
    'app.stopped': 'Шерпа остановилась',
    'app.connecting': 'Подключаюсь к серверу…',
    'app.reconnecting': 'Сервер недоступен, переподключаюсь…',
    'app.reconnecting.text':
        'На экране последнее известное состояние. Как только связь вернётся, оно обновится само.',
    'app.noToken.text': 'Открой UI ссылкой из запуска скилла Шерпы или сервера — в ней токен доступа.',
    'app.noToken.hint': 'http://127.0.0.1:<порт>/#t=<токен>',
    'app.closeChat': 'Закрыть чат',

    

    'command.hint': 'Запусти в любом харнесе — сессия станет воркером.',
    'command.copy': 'Скопировать',
    'command.copied': 'Скопировано',
    'command.copied.status': 'Команда скопирована',
    'command.manual': 'Команда выделена — скопируй вручную',
    'command.aria': 'Команда запуска Шерпы',

    'topbar.breadcrumb': 'Пул-реквест',
    'topbar.search': 'Поиск',
    'topbar.agent.disconnected': 'Агент отключён. Читалка продолжает работать полностью.',
    'topbar.agent.connect': 'Подключить агента',
    'topbar.agent.offline':
        'Читалка работает полностью — дифф, поиск, комментарии и шип доступны. ИИ-зоны остались только для чтения.',
    'topbar.update': (latest: string) => `Доступна версия ${latest}`,

    'update.kicker': 'Обновление',
    'update.title': (latest: string) => `Шерпа ${latest} доступна`,
    'update.current': (current: string) => `у вас ${current}`,
    'update.how': 'Как обновить',
    'update.later': 'Позже',
    'update.dismiss': (latest: string) => `Не напоминать про ${latest}`,
    'update.command.aria': 'Команда обновления',
    'update.copyDir': (dir: string) => `Скопируйте каталог заново: ${dir}`,
    'update.readme': 'Инструкция по установке',
    'update.status.none': (current: string) => `Обновлений нет — ${current} последняя`,
    'update.status.available': (latest: string) => `Доступна ${latest}`,
    'update.status.failed': 'Не удалось проверить обновления',

    'view.overview': 'Обзор',
    'view.route': 'Маршрут',
    'view.diff': 'Полный дифф',
    'view.tabs': 'Вью',

    'route.invitation.title': 'Маршрута для этого PR ещё нет',
    'route.invitation.text':
        'Запусти скилл в своём харнесе, чтобы построить маршрут. Полный дифф уже доступен и не ждёт агента.',
    'route.readFullDiff': 'Читать полный дифф',
    'route.toFullDiff': 'К полному диффу',
    'route.iteration.title': 'Для этой итерации маршрута нет',
    'route.iteration.text': 'Маршрут строится для активной итерации; эту можно только читать.',
    'route.iteration.textCommit': (commit: string) =>
        `Маршрут строится для активной итерации; итерацию ${commit} можно только читать.`,
    'route.slice.title': 'Для среза маршрут не строится',
    'route.slice.text': 'Маршрут для среза между итерациями не строится — это «что нового» без ИИ.',
    'route.smallPr.title': 'Малый PR — маршрут не нужен',
    'route.smallPr.text':
        'Изменений меньше порога, за которым маршрут окупается: пара файлов читается быстрее, чем агент успевает построить план. Генерацию сервер не ставил — ни очереди, ни ожидания.',
    'route.smallPr.notGenerated': 'PR ниже порога маршрута — генерация не запускается.',

    'file.conflict': 'conflict',
    'route.stop.conflicts': (files: number) =>
        `${num(files)} ${form(files, 'файл этой остановки', 'файла этой остановки', 'файлов этой остановки')} в конфликте: разрешите их в хосте. В покрытие маршрута конфликты не входят, поэтому карточек здесь нет.`,
    'route.other.none': 'Без остановки не осталось ни одной изменённой строки — весь дифф разобран маршрутом.',
    'route.other.conflictsOnly':
        'Этот слот держат только конфликты: маршрут их не объясняет и прочитать их здесь нельзя.',
    'route.other.conflicts': (files: number) =>
        `${num(files)} ${form(files, 'файл с конфликтом', 'файла с конфликтами', 'файлов с конфликтами')} — разрешите их в хосте, в покрытие они не входят`,
    'route.cap.note': (covered: number, total: number) =>
        `план покрывает ${num(covered)} ${form(covered, 'файл', 'файла', 'файлов')} из ${num(total)}`,
    'route.cap.note.machine': (covered: number, total: number, machine: number) =>
        `план покрывает ${num(covered)} ${form(covered, 'файл', 'файла', 'файлов')} из ${num(total)}; ${num(machine)} ${form(machine, 'машинный', 'машинных', 'машинных')} — одной остановкой`,
    'banner.generationCap': (files: number) =>
        `Маршрут построен не по всему диффу: ${num(files)} ${form(files, 'файл не влез', 'файла не влезли', 'файлов не влезли')} в контекст агента — проверьте их в Полном диффе`,

    'emptyPr.title': 'Нечего ревьюить',
    'emptyPr.text': 'В этом PR нет изменений относительно базы.',

    'overview.slice.title': 'Для среза обзор не собирается',
    'overview.slice.text': (baseCommit: string, headCommit: string) =>
        `Зоны ответственности, обсуждения и прогресс чтения считаются по активной итерации. Срез ${baseCommit} → ${headCommit} — это только «что нового» в коде.`,
    'overview.summary': 'Кратко',
    'overview.summary.loading': 'Краткое описание PR готовится',
    'overview.summary.failed.lead': 'Краткого описания нет.',
    'overview.summary.failed.text':
        'Оно приезжает вместе со скелетом маршрута, а генерация до него не дошла. Полный дифф это не задевает.',
    'overview.summary.smallPr.lead': 'Малый PR — маршрут не нужен.',
    'overview.summary.smallPr.text':
        'Изменений меньше порога, за которым маршрут окупается: агент не запускался, краткого описания нет.',
    'overview.summary.noRoute.lead': 'Маршрута ещё нет.',
    'overview.summary.noRoute.text': 'Запусти скилл, чтобы агент собрал маршрут и краткое описание PR.',
    'overview.ownership.title': 'Файлы по зонам ответственности',
    'overview.ownership.segments': 'Файлы по зоне ответственности',
    'overview.ownership.stats': (mineFiles: number, totalFiles: number, mineLines: number, totalLines: number) =>
        `CODEOWNERS · ${num(mineFiles)} из ${num(totalFiles)} файлов · ${num(mineLines)} из ${num(totalLines)} строк — ваши`,
    'overview.ownership.statsUnavailable': 'CODEOWNERS · зона ответственности недоступна',
    'overview.ownership.mine': (files: number) => `Моя зона ${num(files)}`,
    'overview.ownership.all': (files: number) => `Все ${num(files)}`,
    'overview.ownership.noZone': 'Хост не отдал зону ответственности для этого PR.',
    'overview.ownership.noHost': 'У этого PR нет ревью-хоста, поэтому зона ответственности недоступна.',
    'overview.ownership.loading': 'Зона ответственности загружается…',
    'overview.ownership.chip.mine': 'ваши',
    'overview.ownership.chip.mineOwner': (owner: string) => `ваши · ${owner}`,
    'overview.ownership.chip.other': 'чужие',
    'overview.ownership.chip.generated': 'машинные',
    'overview.ownership.chip.mixed': 'смешанные',
    'overview.ownership.rowStats': (files: number, lines: number) =>
        `${num(files)} ${form(files, 'файл', 'файла', 'файлов')} · ${num(lines)} ${form(lines, 'строка', 'строки', 'строк')}`,
    'overview.diff.loading': 'Дифф загружается…',
    'overview.diff.unavailable': 'Дифф недоступен — агрегировать файлы пока нельзя.',
    'overview.discussion': 'Обсуждение',
    'overview.discussion.loading': 'Обсуждения загружаются…',
    'overview.discussion.empty': 'Обсуждений нет.',
    'overview.discussion.open': 'открыты',
    'overview.discussion.resolved': 'закрыты',
    'overview.discussion.bots': 'от ботов',
    'overview.discussion.noOutside': 'К самому PR и вне диффа тредов нет.',
    'overview.snapshots': 'Снапшоты',

    'palette.title': 'Палитра команд',
    'palette.placeholder': 'Команда, файл, /поиск или :строка',
    'palette.placeholder.files': 'Файл…',
    'palette.group.commands': 'Команды',
    'palette.group.files': 'Файлы',
    'palette.group.jump': 'Переход',
    'palette.group.recent': 'Недавнее',
    'palette.group.search': 'Поиск',
    'palette.group.sherpa': 'Шерпа',
    'palette.group.suggested': 'Предложения',
    'palette.recent.empty': 'Пока нет недавних команд',
    'palette.results': 'Результаты палитры',
    'palette.results.count': (count: number) =>
        `${num(count)} ${form(count, 'результат', 'результата', 'результатов')}`,
    'palette.notice.nothing': 'Ничего не нашлось',
    'palette.notice.nothingFor': (query: string) => `Ничего не нашлось по «${query}»`,
    'palette.notice.openFile': 'Сначала откройте файл',
    'palette.notice.lineNumber': 'Введите номер строки после двоеточия',
    'palette.notice.lineMissing': (line: number, path: string) => `Строки ${num(line)} нет в файле ${path}`,
    'palette.notice.diffLoading': 'Дифф ещё загружается',
    'palette.notice.diffFailed': (error: string) => `Не удалось загрузить дифф: ${error}`,
    'palette.notice.searchText': 'Введите текст после /',
    'palette.goToLine': (line: number) => `Перейти к строке ${num(line)}`,
    'palette.truncated': (limit: number) => `Показаны первые ${num(limit)} совпадений`,

    'banner.slot': 'Уведомления о состоянии ревью',
    'banner.slot.more': (count: number) =>
        `+${num(count)} ${form(count, 'уведомление', 'уведомления', 'уведомлений')}`,

    'ship.progress': (seen: number, total: number) => `${num(seen)} / ${num(total)} файлов`,
    'ship.loading.files': 'файлов',
    'ship.loading.filesAria': 'Счётчик файлов загружается',
    'ship.loading.comments': 'комментарии загружаются',
    'ship.loading.reason': 'Дифф и данные ревью ещё загружаются.',
    'ship.diffFailed': 'дифф не загрузился',
    'ship.diffFailed.reason': (error: string) => `Дифф не загрузился: ${error}`,
    'ship.prComment': 'Комментарий к PR',
    'ship.chooseMode': 'Выбрать режим шипа',
    'ship.menu': 'Режим шипа',
    'ship.noDrafts': 'нет неопубликованных комментариев',
    'ship.drafts': (drafts: number) =>
        `${num(drafts)} ${form(drafts, 'черновик', 'черновика', 'черновиков')} ${form(drafts, 'уйдёт', 'уйдут', 'уйдут')} при шипе`,
    'ship.drafts.pinned': (drafts: number) =>
        `· ${num(drafts)} ${form(drafts, 'закреплён', 'закреплены', 'закреплены')} за прошлыми коммитами`,
    'ship.publishing': 'Публикуется…',
    'ship.guard.stops': (stops: number) =>
        `${num(stops)} ${form(stops, 'остановка не просмотрена', 'остановки не просмотрено', 'остановок не просмотрено')} — всё равно шипнуть?`,
    'ship.guard.files': (files: number) =>
        `${num(files)} ${form(files, 'файл не просмотрен', 'файла не просмотрено', 'файлов не просмотрено')} — всё равно шипнуть?`,
    'ship.mode.ship': 'Ship',
    'ship.mode.sticky': 'Sticky ship',
    'ship.mode.ship.description': 'Одобряет только этот снапшот. Новый пуш снимает одобрение и спросит снова.',
    'ship.mode.sticky.description': 'Одобрение переносится на следующие пуши — обычный sticky ship хоста.',
    'ship.mode.sticky.unavailable': 'Этот хост не поддерживает Sticky ship.',
    'ship.option.publishes': (drafts: number) =>
        `Опубликует ${num(drafts)} ${form(drafts, 'черновик', 'черновика', 'черновиков')}.`,
    'ship.consequence.ship': (drafts: number) =>
        `Опубликует ${num(drafts)} ${form(drafts, 'черновик', 'черновика', 'черновиков')} и одобрит снапшот`,
    'ship.consequence.requestChanges': (drafts: number) =>
        `Опубликует ${num(drafts)} ${form(drafts, 'черновик', 'черновика', 'черновиков')} и запросит изменения`,
    'ship.disabled.publishing': 'публикуется…',
    'ship.disabled.offline': 'нет связи с сервером',
    'ship.disabled.pending': 'есть несохранённый текст',
    'ship.disabled.retry': 'сначала повторите предыдущую публикацию',
    'ship.error.failed': 'Не удалось завершить ревью',
    'ship.error.comments': (count: number) =>
        `${num(count)} ${form(count, 'комментарий не опубликовался', 'комментария не опубликовались', 'комментариев не опубликовались')}`,
    'ship.error.retry': 'повторить',
    'ship.error.comment': (commentId: string) => `Комментарий ${commentId}`,
    'ship.error.verdict': 'Хост не применил вердикт.',

    'shortcut.view.overview': 'Вью «Обзор»',
    'shortcut.view.route': 'Вью «Маршрут»',
    'shortcut.view.diff': 'Вью «Полный дифф»',
    'shortcut.palette.open': 'Открыть палитру команд',
    'shortcut.palette.goToFile': 'Перейти к файлу',
    'shortcut.palette.searchDiff': 'Искать в содержимом диффа',
    'shortcut.diff.toggleMode': 'Переключить режим диффа',
    'shortcut.diff.markViewed': 'Отметить файл просмотренным',
    'shortcut.diff.filterFiles': 'Фильтр файлов в дереве',
    'shortcut.thread.commentLine': 'Комментировать строку под курсором',
    'shortcut.thread.reply': 'Ответить в тред под курсором',
    'shortcut.review.shipMenu': 'Открыть меню шипа',
    'shortcut.review.requestChanges': 'Request changes',
    'shortcut.route.stop': (stop: string) => `Перейти к остановке ${stop}`,
    'shortcut.route.toggleStopViewed': 'Отметить остановку просмотренной',
    'shortcut.route.toggleStopCollapse': 'Свернуть или раскрыть остановку',
    'shortcut.route.togglePreset': 'Переключить пресет (триаж / полный тур)',
    'shortcut.route.preset.tour': 'переставит остановки в порядок чтения',
    'shortcut.route.preset.triage': 'вернёт порядок триажа',
    'shortcut.route.generate': 'Построить маршрут',
    'shortcut.route.regenerate': 'Перегенерировать маршрут',
    'shortcut.route.generate.consequence': 'сбросит отметки остановок, когда новый маршрут приедет',
    'shortcut.update.check': 'Проверить обновления',
    'shortcut.update.check.consequence': 'проверит наличие нового релиза',
    'shortcut.locale.ru': 'Язык интерфейса: русский',
    'shortcut.locale.en': 'Язык интерфейса: английский',
    'shortcut.locale.auto': 'Язык: авто (от агента или браузера)',
    'shortcut.locale.now.ru': 'сейчас: русский',
    'shortcut.locale.now.en': 'сейчас: английский',
    'shortcut.locale.now.agentRu': 'сейчас: русский (от агента)',
    'shortcut.locale.now.agentEn': 'сейчас: английский (от агента)',
    'shortcut.locale.now.browserRu': 'сейчас: русский (как в браузере)',
    'shortcut.locale.now.browserEn': 'сейчас: английский (как в браузере)',

    'time.justNow': 'только что',
};

/**
 * Dictionary shape: strings stay strings, functions keep their signatures. The English dictionary
 * uses this type so the compiler catches missing keys, extra keys and different sets of
 * parameters.
 */
export type Dictionary = {
    [K in keyof typeof ru]: (typeof ru)[K] extends (...args: infer A) => string ? (...args: A) => string : string;
};

export type MessageKey = keyof typeof ru;
