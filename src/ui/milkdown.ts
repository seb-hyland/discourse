import { syntaxHighlighting } from "@codemirror/language";
import { Crepe } from "@milkdown/crepe";
import { syntaxClasses } from "./syntax.ts";

const { Feature } = Crepe;
const allOff = Object.fromEntries(Object.values(Feature).map((f) => [f, false]));

const features = {
    ...allOff,
    [Feature.ListItem]: true,
    [Feature.Table]: true,
    [Feature.ImageBlock]: true,
    [Feature.BlockEdit]: true,
    [Feature.TopBar]: true,
    [Feature.Toolbar]: true,
    [Feature.LinkTooltip]: true,
    [Feature.Placeholder]: true,
    [Feature.CodeMirror]: true,
};

/** A WYSIWYG markdown editor in `root`, reporting each change. */
export async function createMarkdownEditor(root: HTMLElement, markdown: string, onChange: (markdown: string) => void): Promise<Crepe> {
    const crepe = new Crepe({
        root,
        defaultValue: markdown,
        features,
        featureConfigs: {
            [Feature.CodeMirror]: { theme: syntaxHighlighting(syntaxClasses) },
            [Feature.Placeholder]: { text: "Write a comment, or / for blocks…", mode: "doc" },
            // Fixed positioning keeps the slash menu from being clipped by the scrolling thread panel.
            // BlockEdit's drag handle is hidden in styles.css; we only want its slash menu.
            [Feature.BlockEdit]: { slashMenu: { floatingUIOptions: { strategy: "fixed" } } },
        },
    });
    crepe.on((listener) => listener.markdownUpdated((_, markdown) => onChange(markdown)));
    await crepe.create();
    return crepe;
}
