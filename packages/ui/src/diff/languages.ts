import clojure from 'highlight.js/lib/languages/clojure';
import cmake from 'highlight.js/lib/languages/cmake';
import dart from 'highlight.js/lib/languages/dart';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import elixir from 'highlight.js/lib/languages/elixir';
import erlang from 'highlight.js/lib/languages/erlang';
import groovy from 'highlight.js/lib/languages/groovy';
import haskell from 'highlight.js/lib/languages/haskell';
import nginx from 'highlight.js/lib/languages/nginx';
import properties from 'highlight.js/lib/languages/properties';
import protobuf from 'highlight.js/lib/languages/protobuf';
import scala from 'highlight.js/lib/languages/scala';
import type { LanguageFn } from 'highlight.js';
import { common, createLowlight } from 'lowlight';

/**
 * highlight.js grammar registry: lowlight's `common` set (37 languages) plus languages often
 * found in our diffs that are not in `common`.
 *
 * The registry is static: grammars are bundled in full. Lazy loading would require
 * asynchronous initialization, but `parseFileDiff` is synchronous (the gallery calls it during render).
 */
export const lowlight = createLowlight(common);

const EXTRA: Readonly<Record<string, LanguageFn>> = {
    clojure,
    cmake,
    dart,
    dockerfile,
    elixir,
    erlang,
    groovy,
    haskell,
    nginx,
    properties,
    protobuf,
    scala,
};

for (const [name, language] of Object.entries(EXTRA)) {
    lowlight.register(name, language);
}
