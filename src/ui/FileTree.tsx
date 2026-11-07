import { useEffect, useReducer, type MouseEvent } from "react";
import type { FileSummary, MenuItem } from "../shared/api.ts";
import { api } from "./api.ts";
import { BackIcon, ChevronIcon, CommentIcon, ForwardIcon, IconButton, SearchIcon, SettingsIcon, SidebarIcon } from "./icons.tsx";
import { useStored } from "./util.ts";

interface Folder {
    name: string;
    /** Its path in the workspace. */
    path: string;
    folders: Map<string, Folder>;
    files: FileSummary[];
    openThreads: number;
    unseen: number;
    /** How many files inside need attention. */
    attention: number;
}

export function FileTree({
    files,
    current,
    onOpen,
    onError,
    onSearch,
    searching,
    onSettings,
    picking,
}: {
    files: FileSummary[];
    current: string;
    onOpen: (path: string) => void;
    onError: (e: unknown) => void;
    onSearch: () => void;
    /** The search panel is open. */
    searching: boolean;
    onSettings: () => void;
    /** Picking a file to move `from`'s comments to: every file is shown, and clicking one picks it. */
    picking?: { from: string; onPick: (path: string) => void; onCancel: () => void };
}) {
    const [commentedOnly, setCommentedOnly] = useStored("files.commentedOnly", false);
    const [collapsed, setCollapsed] = useStored("files.collapsed", false);
    const { canGoBack, canGoForward } = useHistory();
    const openThreads = files.reduce((n, f) => n + f.openThreads, 0);
    const unseen = files.reduce((n, f) => n + (f.unseen ?? 0), 0);
    const shown = files.filter((f) => picking || !commentedOnly || f.openThreads + f.resolvedThreads > 0);
    const hidden = collapsed && !picking;
    useEffect(() => {
        if (!picking) return;
        const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && picking.onCancel();
        addEventListener("keydown", onKeyDown);
        return () => removeEventListener("keydown", onKeyDown);
    }, [picking]);

    return (
        <nav className={hidden ? "files collapsed" : picking ? "files picking" : "files"}>
            {!hidden && (
                <div className="tree">
                    {picking ? (
                        <div className="pick-banner">
                            <span>Pick a file to move the comments to</span>
                            <button onClick={picking.onCancel}>Cancel</button>
                        </div>
                    ) : (
                        <button className={current === "" ? "all-threads current" : "all-threads"} onClick={() => onOpen("")}>
                            <CommentIcon />
                            <span className="name">All threads</span>
                            <Count open={openThreads} unseen={unseen} />
                        </button>
                    )}
                    <hr className="divider" />
                    <FolderContents
                        folder={buildTree(shown)}
                        current={current}
                        onOpen={picking ? picking.onPick : onOpen}
                        unpickable={picking && ((f) => f.missing || f.path === picking.from)}
                        onMenu={(e, path, file) => void showMenu(e, path, file, onError)}
                    />
                </div>
            )}
            <footer>
                <IconButton tip={collapsed ? "Show sidebar" : "Hide sidebar"} onClick={() => setCollapsed(!collapsed)}>
                    <SidebarIcon />
                </IconButton>
                {!hidden && (
                    <>
                        <IconButton tip="Back" disabled={!canGoBack} onClick={() => history.back()}>
                            <BackIcon />
                        </IconButton>
                        <IconButton tip="Forward" disabled={!canGoForward} onClick={() => history.forward()}>
                            <ForwardIcon />
                        </IconButton>
                        <span className="spacer" />
                        <IconButton tip="Search (⌘F)" on={searching} onClick={onSearch}>
                            <SearchIcon />
                        </IconButton>
                        <IconButton tip="Only show commented files" on={commentedOnly} onClick={() => setCommentedOnly(!commentedOnly)}>
                            <CommentIcon />
                        </IconButton>
                        <IconButton tip="Settings" onClick={onSettings}>
                            <SettingsIcon />
                        </IconButton>
                    </>
                )}
            </footer>
        </nav>
    );
}

/** A file's or folder's context menu: to open it elsewhere, or find it or its comments in the file manager. */
async function showMenu(e: MouseEvent, path: string, file: FileSummary | undefined, onError: (e: unknown) => void) {
    e.preventDefault();
    const commented = !!file && (file.openThreads + file.resolvedThreads > 0 || !!file.attention);
    const items: MenuItem[] = [
        ...(file ? [{ id: "editor", label: "Open in editor", enabled: !file.missing }] : []),
        { id: "file", label: "Show in file manager", enabled: !file?.missing },
        ...(commented ? [{ id: "comments", label: "Show comments directory" }] : []),
    ];
    try {
        const chosen = await api.menu(items);
        if (chosen === "editor") await api.openInEditor(path, 1, 1);
        else if (chosen === "file" || chosen === "comments") await api.reveal(path, chosen);
    } catch (e) {
        onError(e);
    }
}

/** Whether the window can go back or forward through the files and comments opened. */
function useHistory() {
    const [, update] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        navigation.addEventListener("currententrychange", update);
        return () => navigation.removeEventListener("currententrychange", update);
    }, []);
    return { canGoBack: navigation.canGoBack, canGoForward: navigation.canGoForward };
}

function FolderContents({
    folder,
    current,
    onOpen,
    unpickable,
    onMenu,
}: {
    folder: Folder;
    current: string;
    onOpen: (path: string) => void;
    /** While picking a file, those that can't be picked. */
    unpickable?: (file: FileSummary) => boolean | undefined;
    onMenu: (e: MouseEvent, path: string, file?: FileSummary) => void;
}) {
    return (
        <ul>
            {[...folder.folders.values()].map((sub) => (
                <li key={sub.name}>
                    <details open>
                        <summary onContextMenu={(e) => onMenu(e, sub.path)}>
                            <ChevronIcon />
                            <span className="name">{sub.name}</span>
                            {/* Shown only while the folder is folded, by the stylesheet. */}
                            <Count
                                open={sub.openThreads}
                                unseen={sub.unseen}
                                attention={sub.attention ? `${sub.attention} ${sub.attention === 1 ? "file needs" : "files need"} attention` : undefined}
                            />
                        </summary>
                        <FolderContents folder={sub} current={current} onOpen={onOpen} unpickable={unpickable} onMenu={onMenu} />
                    </details>
                </li>
            ))}
            {folder.files.map((f) => (
                <li key={f.path}>
                    <button
                        className={f.path === current ? "current" : undefined}
                        disabled={unpickable?.(f)}
                        onClick={() => onOpen(f.path)}
                        onContextMenu={(e) => onMenu(e, f.path, f)}
                    >
                        <span
                            className={f.missing ? "name missing" : "name"}
                            data-tip={f.missing ? "Deleted, but its comments remain; open it to restore it" : undefined}
                        >
                            {f.path.slice(f.path.lastIndexOf("/") + 1)}
                        </span>
                        <Count open={f.openThreads} unseen={f.unseen ?? 0} attention={f.attention} />
                    </button>
                </li>
            ))}
        </ul>
    );
}

function buildTree(files: FileSummary[]): Folder {
    const root = folder("", "");
    for (const file of files) {
        let at = root;
        at.openThreads += file.openThreads;
        at.unseen += file.unseen ?? 0;
        for (const name of file.path.split("/").slice(0, -1)) {
            if (!at.folders.has(name)) at.folders.set(name, folder(name, at.path ? `${at.path}/${name}` : name));
            at = at.folders.get(name)!;
            at.openThreads += file.openThreads;
            at.unseen += file.unseen ?? 0;
            if (file.attention) at.attention++;
        }
        at.files.push(file);
    }
    return compact(root);
}

/** Merges folders that only contain one folder, as in `sources/thelang-naive`. */
function compact(f: Folder): Folder {
    for (const [key, sub] of f.folders) f.folders.set(key, compact(sub));
    const [only] = f.folders.values();
    if (f.name && f.files.length === 0 && f.folders.size === 1) return { ...only, name: `${f.name}/${only.name}` };
    return f;
}

function folder(name: string, path: string): Folder {
    return { name, path, folders: new Map(), files: [], openThreads: 0, unseen: 0, attention: 0 };
}

/** Open threads, coloured if any are unread, or red if something needs settling; "!" if that's all there is. */
function Count({ open, unseen, attention }: { open: number; unseen: number; attention?: string }) {
    const unread = unseen === 0 ? undefined : unseen === 1 ? "1 unread comment" : `${unseen} unread comments`;
    const tip = [attention, unread].filter(Boolean).join(" · ") || undefined;
    if (open > 0 || attention)
        return (
            <span className={attention ? "count broken" : unseen ? "count unread" : "count"} data-tip={tip}>
                {open || "!"}
            </span>
        );
    return unseen > 0 && <span className="unread-dot" data-tip={tip} />;
}
