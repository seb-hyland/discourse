import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import type { CommentUpdate, DocumentView as Doc, FileSummary, NewComment, Span } from "../shared/api.ts";
import { api } from "./api.ts";
import { DocumentView, type DocumentHandle } from "./DocumentView.tsx";
import { FileTree } from "./FileTree.tsx";
import { CloseIcon, IconButton } from "./icons.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { ThreadPanel } from "./ThreadPanel.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** Changes to the open document's comments. Each resolves to whether it worked; failures are shown. */
export interface Actions {
  add(comment: NewComment): Promise<boolean>;
  update(id: string, update: CommentUpdate): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  resolveConflict(id: string, version: number): Promise<boolean>;
  restoreParent(replyId: string): Promise<boolean>;
  /** Opens the document in the user's editor, at the start of `span`. */
  openInEditor(span: Span): Promise<boolean>;
}

export function App() {
  const [files, setFiles] = useState<FileSummary[]>([]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const shown = useRef(doc);
  shown.current = doc;
  const [active, setActive] = useState<string | null>(null);
  /** Text the user is writing a new comment on. */
  const [draft, setDraft] = useState<Span | null>(null);
  const [selection, setSelection] = useState<Span | null>(null);
  const documentView = useRef<DocumentHandle>(null);
  const [error, setError] = useState<string | null>(null);
  const report = (e: unknown) => setError((e as Error).message);
  /** A comment a followed link points to, to show once its document is open. */
  const [linked, setLinked] = useState<string | null>(null);
  const [filesWidth, setFilesWidth] = useStoredWidth("files", 240, [160, 480]);
  const [threadsWidth, setThreadsWidth] = useStoredWidth("threads", 380, [280, 800]);

  /**
   * Shows the document at `path`. One that can't be opened leaves the shown one, with the URL put
   * back to match it. Only the latest request counts, however they finish.
   */
  const latest = useRef(0);
  const show = async (path: string) => {
    const request = ++latest.current;
    try {
      const next = path ? await api.document(path) : null;
      if (request !== latest.current) return;
      if (next?.path !== shown.current?.path) {
        setDraft(null);
        setSelection(null);
        setActive(null);
      }
      setDoc(next);
    } catch (e) {
      if (request !== latest.current) return;
      report(e);
      history.replaceState(null, "", hashOf(shown.current?.path ?? ""));
    }
  };

  // The open document is the URL's hash, so reloads and back/forward work.
  useEffect(() => {
    const onHashChange = () => void show(pathOf(location.hash));
    onHashChange();
    void api.files().then(setFiles, report);
    addEventListener("hashchange", onHashChange);
    return () => removeEventListener("hashchange", onHashChange);
  }, []);

  // Saves elsewhere arrive in bursts, so wait for them to settle before refreshing.
  useEffect(() => {
    const pending = { files: false, doc: false };
    let timer: ReturnType<typeof setTimeout>;
    return api.onChange(({ path, listChanged }) => {
      pending.files ||= listChanged;
      pending.doc ||= path === shown.current?.path;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (pending.files) void api.files().then(setFiles, report);
        if (pending.doc && shown.current) void show(shown.current.path);
        pending.files = pending.doc = false;
      }, 200);
    });
  }, []);

  const open = (path: string) => (location.hash = hashOf(path));

  const run = async (change: (path: string) => Promise<Doc | void>) => {
    try {
      const next = await change(doc!.path);
      if (next) setDoc(next);
      setError(null);
      return true;
    } catch (e) {
      report(e);
      return false;
    }
  };

  const actions: Actions = {
    add: async (comment) => {
      const added = await run((path) => api.add(path, comment));
      if (added && "span" in comment) setDraft(null);
      return added;
    },
    update: (id, update) => run((path) => api.update(path, id, update)),
    remove: (id) => run((path) => api.remove(path, id)),
    resolveConflict: (id, version) => run((path) => api.resolveConflict(path, id, version)),
    restoreParent: (replyId) => run((path) => api.restoreParent(path, replyId)),
    openInEditor: (span) => run((path) => api.openInEditor(path, span.from)),
  };

  // A mouse's back and forward buttons go back and forward through the files and comments opened.
  useEffect(() => {
    const onMouseUp = (e: globalThis.MouseEvent) => {
      if (e.button === 3) history.back();
      if (e.button === 4) history.forward();
    };
    addEventListener("mouseup", onMouseUp);
    return () => removeEventListener("mouseup", onMouseUp);
  }, []);

  // ⌘Z and ⇧⌘Z undo and redo changes to comments, except while typing, where they're the typing's own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!doc || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || isTyping(e.target)) return;
      e.preventDefault();
      void run((path) => api.undo(path, e.shiftKey));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [doc]);

  const reveal = (id: string) => {
    setActive(id);
    const span = doc?.threads.find((t) => t.id === id)?.span;
    if (span) documentView.current?.reveal(span);
  };

  /** Follows links in rendered markdown: text files open here, anything else in its own app. */
  const followLink = (e: MouseEvent) => {
    const link = (e.target as Element).closest<HTMLAnchorElement>(".markdown a[href]");
    if (!link || link.isContentEditable || !doc) return;
    e.preventDefault();
    const href = link.getAttribute("href")!;
    if (/^([a-z][\w+.-]*:|\/\/)/i.test(href)) return void window.open(href);
    // Relative to the open file, as written in the repository.
    const url = new URL(href, `file:///${doc.path}`);
    const target = decodeURIComponent(url.pathname.slice(1));
    const comment = url.hash.startsWith("#comment-") && url.hash.slice("#comment-".length);
    if (target !== doc.path && !files.some((f) => f.path === target)) return void api.openFile(target).catch(report);
    if (comment) setLinked(comment);
    if (target !== doc.path) open(target);
    else if (url.hash && !comment) document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    const thread = linked && doc?.threads.find((t) => t.comments.some((c) => c.id === linked));
    if (!thread) return;
    setLinked(null);
    reveal(thread.id);
    // Once the thread has scrolled into view, bring the comment itself there and flash it.
    setTimeout(() => {
      const comment = document.querySelector(`[data-comment="${CSS.escape(linked)}"]`);
      comment?.scrollIntoView({ block: "center", behavior: "smooth" });
      const flash = "var(--highlight-active)";
      comment?.animate([{ background: flash, boxShadow: `0 0 0 6px ${flash}` }, {}], { duration: 2500, easing: "ease-in" });
    }, 500);
  }, [linked, doc]);

  return (
    <div
      className="app"
      style={{ "--files-size": `${filesWidth}px`, "--threads-size": `${threadsWidth}px` } as CSSProperties}
      onClickCapture={followLink}
    >
      <FileTree files={files} current={doc?.path ?? ""} onOpen={open} onSettings={() => api.editSettings().catch(report)} />
      <ResizeHandle panel="files" width={filesWidth} onResize={setFilesWidth} />
      <main>
        {doc && (
          <DocumentView
            key={doc.path}
            ref={documentView}
            doc={doc}
            active={active}
            draft={draft}
            selection={selection}
            onActivate={setActive}
            onSelect={setSelection}
            onOpenInEditor={actions.openInEditor}
            onComment={(span) => {
              setDraft(span);
              setSelection(null);
              setActive(null);
            }}
          />
        )}
      </main>
      {doc && <ResizeHandle panel="threads" width={threadsWidth} onResize={setThreadsWidth} />}
      {doc && (
        <ThreadPanel
          doc={doc}
          active={active}
          draft={draft}
          selection={selection}
          onActivate={reveal}
          onMove={async (id) => {
            if (!(await actions.update(id, { span: selection! }))) return;
            setSelection(null);
            setActive(id);
          }}
          onCancelDraft={() => setDraft(null)}
          actions={actions}
        />
      )}
      {error && (
        <div className="error-popup" role="alert">
          <p>{error}</p>
          <IconButton tip="Dismiss" onClick={() => setError(null)}>
            <CloseIcon />
          </IconButton>
        </div>
      )}
      <Tooltip />
    </div>
  );
}

const hashOf = (path: string) => `#${encodeURIComponent(path).replaceAll("%2F", "/")}`;
const pathOf = (hash: string) => decodeURIComponent(hash.slice(1));

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea"));

/** A panel's width, kept within bounds and remembered between visits. */
function useStoredWidth(panel: string, initial: number, [min, max]: [number, number]) {
  const key = `width.${panel}`;
  const [width, setWidth] = useState(() => Number(localStorage.getItem(key)) || initial);
  const resize = (to: number) => {
    const clamped = Math.round(Math.min(max, Math.max(min, to)));
    localStorage.setItem(key, String(clamped));
    setWidth(clamped);
  };
  return [width, resize] as const;
}
