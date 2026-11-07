import { useEffect, useReducer, useState } from "react";
import type { FileSummary } from "../shared/api.ts";
import { BackIcon, ChevronIcon, CommentIcon, ForwardIcon, IconButton, SearchIcon, SettingsIcon, SidebarIcon } from "./icons.tsx";
import { useStored } from "./util.ts";

interface Folder {
    name: string;
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
    onSearch,
    searching,
    onSettings,
}: {
    files: FileSummary[];
    current: string;
    onOpen: (path: string) => void;
    onSearch: () => void;
    /** The search panel is open. */
    searching: boolean;
    onSettings: () => void;
}) {
    const [filter, setFilter] = useState("");
    const [commentedOnly, setCommentedOnly] = useState(false);
    const [collapsed, setCollapsed] = useStored("files.collapsed", false);
    const { canGoBack, canGoForward } = useHistory();
    const openThreads = files.reduce((n, f) => n + f.openThreads, 0);
    const unseen = files.reduce((n, f) => n + (f.unseen ?? 0), 0);
    const shown = files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()) && (!commentedOnly || f.openThreads + f.resolvedThreads > 0));

    return (
        <nav className={collapsed ? "files collapsed" : "files"}>
            {!collapsed && (
                <div className="tree">
                    <button className={current === "" ? "all-threads current" : "all-threads"} onClick={() => onOpen("")}>
                        <CommentIcon />
                        <span className="name">All threads</span>
                        <Count open={openThreads} unseen={unseen} />
                    </button>
                    <hr className="divider" />
                    <FolderContents folder={buildTree(shown)} current={current} onOpen={onOpen} />
                </div>
            )}
            {!collapsed && (
                <div className="filter">
                    <input placeholder="Find a file…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                    <IconButton tip="Only show commented files" on={commentedOnly} onClick={() => setCommentedOnly(!commentedOnly)}>
                        <CommentIcon />
                    </IconButton>
                </div>
            )}
            <footer>
                <IconButton tip={collapsed ? "Show sidebar" : "Hide sidebar"} onClick={() => setCollapsed(!collapsed)}>
                    <SidebarIcon />
                </IconButton>
                {!collapsed && (
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
                        <IconButton tip="Settings" onClick={onSettings}>
                            <SettingsIcon />
                        </IconButton>
                    </>
                )}
            </footer>
        </nav>
    );
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

function FolderContents({ folder, current, onOpen }: { folder: Folder; current: string; onOpen: (path: string) => void }) {
    return (
        <ul>
            {[...folder.folders.values()].map((sub) => (
                <li key={sub.name}>
                    <details open>
                        <summary>
                            <ChevronIcon />
                            <span className="name">{sub.name}</span>
                            {/* Shown only while the folder is folded, by the stylesheet. */}
                            <Count
                                open={sub.openThreads}
                                unseen={sub.unseen}
                                attention={sub.attention ? `${sub.attention} ${sub.attention === 1 ? "file needs" : "files need"} attention` : undefined}
                            />
                        </summary>
                        <FolderContents folder={sub} current={current} onOpen={onOpen} />
                    </details>
                </li>
            ))}
            {folder.files.map((f) => (
                <li key={f.path}>
                    <button className={f.path === current ? "current" : undefined} onClick={() => onOpen(f.path)}>
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
    const root = folder("");
    for (const file of files) {
        let at = root;
        at.openThreads += file.openThreads;
        at.unseen += file.unseen ?? 0;
        for (const name of file.path.split("/").slice(0, -1)) {
            if (!at.folders.has(name)) at.folders.set(name, folder(name));
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

function folder(name: string): Folder {
    return { name, folders: new Map(), files: [], openThreads: 0, unseen: 0, attention: 0 };
}

/**
 * How many open threads a file or folder has, picked out if the user has comments in it to read.
 * With only resolved threads to read, a dot says so instead.
 */
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
