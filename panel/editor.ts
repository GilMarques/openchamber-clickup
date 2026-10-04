// Shared CodeMirror markdown editor for the ClickUp Tasks extension.
//
// Used by the rail panel's full-panel note view and by the ClickUp Notes page,
// so both edit notes with identical highlighting, keybindings, and theming.
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  defaultHighlightStyle,
  defineLanguageFacet,
  Language,
  LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language";
import { GFM, parser as markdownParser } from "@lezer/markdown";

const editorTheme = () =>
  EditorView.theme(
    {
      "&": { color: "var(--oc-fg, inherit)", backgroundColor: "transparent", fontSize: "13px" },
      ".cm-content": { fontFamily: "var(--oc-mono, monospace)", padding: "8px 0" },
      ".cm-line": { padding: "0 10px" },
      "&.cm-focused": { outline: "none" },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: "var(--oc-muted, inherit)",
        border: "none",
      },
      ".cm-activeLine": { backgroundColor: "var(--oc-hover, transparent)" },
      ".cm-activeLineGutter": { backgroundColor: "var(--oc-hover, transparent)" },
      ".cm-cursor": { borderLeftColor: "var(--oc-fg, inherit)" },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
        backgroundColor: "var(--oc-selection, rgba(127,127,127,0.3))",
      },
    },
    { dark: document.documentElement.dataset.ocTheme === "dark" },
  );

// Bare markdown parser: @codemirror/lang-markdown would also bundle the HTML,
// CSS and JS grammars for embedded blocks (~1 MB); notes do not need them.
// `Language` (not `LRLanguage`) is the wrapper for non-LR parsers.
const markdownLanguage = new LanguageSupport(
  new Language(defineLanguageFacet(), markdownParser.configure([GFM]), [], "markdown"),
);

export const makeEditor = (parent: HTMLElement, text: string, save: () => void): EditorView => {
  const state = EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      markdownLanguage,
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (save(), true) },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      editorTheme(),
    ],
  });
  return new EditorView({ state, parent });
};
