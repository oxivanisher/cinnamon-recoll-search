// SPDX-License-Identifier: GPL-2.0-or-later
//
// Recoll search provider for the Cinnamon menu.
//
// Adds file results (by name and by content) from a Recoll index to the
// search results of the stock Cinnamon menu (menu@cinnamon.org).
//
// Installed and enabled by the recoll-search@mittelerde.ch extension, which
// symlinks this folder into ~/.local/share/cinnamon/search_providers/ and
// adds its uuid to the gsettings key org.cinnamon enabled-search-providers.

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;
const St = imports.gi.St;
const PopupMenu = imports.ui.popupMenu;

// ---- Configuration --------------------------------------------------------

const DEBOUNCE_MS = 150;     // wait this long after the last keystroke
const TIMEOUT_MS = 3000;     // give up on a query after this long
const MAX_OPEN_WITH = 4;     // "Open with <app>" entries in the context menu

// The settings are edited in the extension's settings dialog and saved by
// Cinnamon to this file. Only one settings object may be registered per
// uuid, so the provider reads the file instead of using imports.ui.settings.
const EXTENSION_UUID = "recoll-search@mittelerde.ch";
const SETTINGS_PATH = GLib.build_filenamev([GLib.get_user_config_dir(),
    "cinnamon", "spices", EXTENSION_UUID, `${EXTENSION_UUID}.json`]);

// Used until the extension has created the settings file; keep in sync
// with ../settings-schema.json.
const DEFAULTS = {
    "max-results": 15,       // results shown in the menu
    "min-chars": 3,          // don't search for shorter input
    "show-embedded": true,   // show hits inside archives / mailboxes
    "icon-size": 32,         // should match the menu's "application icon size"
    "show-badge": true,      // mark file icons with a small search badge
    "show-recoll-row": false, // add a "Search ... in Recoll" row above the files
    "recoll-confdir": "",    // "" = default (~/.recoll or $RECOLL_CONFDIR)
};

const RECOLL_ROW_ID = "recoll-search:open-recoll";

let _config = Object.assign({}, DEFAULTS);
let _configMtime = null;

// ---- State ----------------------------------------------------------------

let _generation = 0;         // incremented on every search; drops stale results
let _cancellable = null;
let _debounceId = 0;
let _timeoutId = 0;
const _programs = {};        // name -> path, once found
const _missing = new Set();  // programs already reported as missing
const _decoder = new TextDecoder();

// ---- Settings -------------------------------------------------------------

// Re-read the settings file if it changed since the last search.
function loadConfig() {
    let file = Gio.File.new_for_path(SETTINGS_PATH);
    let mtime;
    try {
        let dt = file.query_info("time::modified,time::modified-usec",
                                 Gio.FileQueryInfoFlags.NONE, null)
            .get_modification_date_time();
        mtime = `${dt.to_unix()}.${dt.get_microsecond()}`;
    } catch (e) {
        return;   // no settings file yet: keep the defaults
    }
    if (mtime === _configMtime)
        return;

    try {
        let [, contents] = file.load_contents(null);
        let saved = JSON.parse(_decoder.decode(contents));
        let config = {};
        for (let key in DEFAULTS) {
            let value = saved[key] ? saved[key].value : undefined;
            config[key] = typeof value === typeof DEFAULTS[key] ? value : DEFAULTS[key];
        }
        _config = config;
        _configMtime = mtime;
    } catch (e) {
        global.logError(`[recoll-search] could not read ${SETTINGS_PATH}: ${e.message}`);
    }
}

// The file chooser saves a URI; accept plain paths as well.
function confdirPath() {
    let dir = _config["recoll-confdir"];
    if (dir.startsWith("file://"))
        dir = Gio.File.new_for_uri(dir).get_path() || "";
    return dir;
}

// ---- Query building -------------------------------------------------------

// Turn the user's input into a Recoll query. Each word matches either the
// content (prefix) or the file name (prefix). In the Recoll query language
// OR binds tighter than the implicit AND, so
//     a* OR filename:a* b* OR filename:b*
// means (a* OR filename:a*) AND (b* OR filename:b*).
//
// Short prefixes ("inv*", "a*") can match more terms than Recoll's
// maxTermExpand allows (default 10000), which makes the whole query fail.
// So this returns a list of queries to try in order, each with fewer
// wildcards: first prefixes everywhere, then whole words for the content
// (still stemmed: "invoice" finds "invoices") and prefixes for file names
// (these expand to far fewer terms), then whole words only.
function buildQueries(pattern) {
    // Keep letters, digits and a few safe characters; everything else
    // (quotes, colons, parentheses, wildcards...) is query syntax.
    // Lowercase so words like "OR"/"AND" are never read as operators.
    let cleaned = pattern.toLowerCase().replace(/[^\p{L}\p{N}_.\-]+/gu, " ");
    let words = cleaned.split(/\s+/)
        .map(w => w.replace(/^[-.]+|[-.]+$/g, ""))  // leading "-" = exclusion
        .filter(w => w.length > 0);

    if (words.length === 0)
        return [];

    return [["*", "*"], ["", "*"], ["", ""]].map(([content, filename]) =>
        words.map(w => `${w}${content} OR filename:${w}${filename}`).join(" "));
}

function buildArgv(query) {
    let argv = [findProgram("recollq")];
    let confdir = confdirPath();
    if (confdir)
        argv.push("-c", confdir);
    // -C  collapse duplicates
    // -n  number of results (fetch a few extra, some may be filtered out)
    // -F  one line per result, fields base64-encoded and space-separated
    argv.push("-C", "-n", String(_config["max-results"] * 2),
              "-F", "url mtype ipath filename title",
              query);
    return argv;
}

// ---- Output parsing -------------------------------------------------------

function b64(s) {
    if (!s)
        return "";
    try {
        return _decoder.decode(GLib.base64_decode(s));
    } catch (e) {
        return "";
    }
}

function parseOutput(stdout) {
    let results = [];
    let seen = new Set();

    for (let line of stdout.split("\n")) {
        // Skip the header lines ("Recoll query: ...", "N results").
        if (!line || line.startsWith("Recoll query:") || /^\d+ results/.test(line))
            continue;

        let f = line.split(" ");
        if (f.length < 2)
            continue;

        let url = b64(f[0]);
        let mtype = b64(f[1]);
        let ipath = b64(f[2]);
        let filename = b64(f[3]);
        let title = b64(f[4]);

        if (!url.startsWith("file://"))
            continue;
        if (ipath && !_config["show-embedded"])
            continue;

        let key = url + "\u0000" + ipath;
        if (seen.has(key))
            continue;
        seen.add(key);

        let file = Gio.File.new_for_uri(url);
        let path = file.get_path();
        if (!path)
            continue;

        let label, description;
        if (ipath) {
            // Hit inside a container (zip, mbox, ...): show the member,
            // describe the container. Selecting opens the container.
            label = title || filename || ipath;
            description = `in ${GLib.path_get_basename(path)}, ${shortPath(GLib.path_get_dirname(path))}`;
        } else {
            label = filename || GLib.path_get_basename(path);
            description = shortPath(GLib.path_get_dirname(path));
        }

        results.push({
            id: key,
            label: label,
            description: description,
            mtype: mtype,
            url: url,
            path: path,
            type: "file",   // anything but "software" is shown by the menu
        });

        if (results.length >= _config["max-results"])
            break;
    }
    return results;
}

function shortPath(dir) {
    let home = GLib.get_home_dir();
    if (dir === home)
        return "~";
    if (dir.startsWith(home + "/"))
        return "~" + dir.slice(home.length);
    return dir;
}

// ---- Icons ----------------------------------------------------------------

// The menu adds result.icon as it is, so it can be any actor of the icon's
// size. File results get a small search badge in the bottom right corner,
// to tell them apart from apps without taking up any space.
function makeBadge(iconSize) {
    let size = Math.max(10, Math.round(iconSize * 0.45));
    let padding = Math.max(1, Math.round(size * 0.15));
    return new St.Icon({
        gicon: Gio.ThemedIcon.new_from_names(
            ["xsi-search-symbolic", "system-search-symbolic", "edit-find-symbolic"]),
        icon_type: St.IconType.SYMBOLIC,
        icon_size: size - 2 * padding,
        style: `background-color: rgba(255, 255, 255, 0.92); color: #1f5f91;` +
               `border-radius: ${size}px; padding: ${padding}px;`,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.END,
    });
}

function addIcon(result) {
    try {
        let size = _config["icon-size"];
        let gicon = result.mtype ? Gio.content_type_get_icon(result.mtype) : null;
        if (!gicon)
            gicon = Gio.ThemedIcon.new("text-x-generic");
        let icon = new St.Icon({ gicon: gicon, icon_size: size });

        if (_config["show-badge"]) {
            let box = new St.Widget({ layout_manager: new Clutter.BinLayout() });
            box.add_child(icon);
            box.add_child(makeBadge(size));
            icon = box;
        }
        result.icon = icon;
    } catch (e) {
        // The menu falls back to no icon.
    }
}

// ---- Result buttons -------------------------------------------------------

// The menu makes a button for each result, but shows only its label (no
// description line, unlike apps) and gives it no context menu. result.icon
// is the first thing added to that button, so it is used to find the
// button and add:
//  - the description as a second line, if the menu's "Show application
//    descriptions" is on. Added just before the next redraw, because the
//    button adds its label only after the icon.
//  - for files, a context menu. The menu opens one (right-click, Menu key,
//    Ctrl+Enter) for buttons with withMenu set and a populateMenu() method.
function setUpButton(result) {
    if (!result.icon)
        return;
    let id = result.icon.connect("parent-set", icon => {
        let parent = icon.get_parent();
        let button = parent ? parent._delegate : null;
        if (!button || button.result !== result)
            return;
        icon.disconnect(id);

        if (result.type === "file") {
            button.withMenu = true;
            button.populateMenu = menu => populateContextMenu(button, menu);
        }

        if (result.description && button.applet.showDescription) {
            Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                if (button.label) {   // not destroyed meanwhile
                    button.addDescription(result.description,
                                          "appmenu-application-button-description");
                    // Long paths: keep the start and the last folders.
                    if (result.type === "file" && button.descriptionLabel)
                        button.descriptionLabel.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
                    button.updateAccessibleName();
                }
                return false;
            });
        }
    });
}

// Open, Edit as text, Open with <app>..., Open containing folder, Copy path.
//
// The desktop (freedesktop.org MIME associations) has no separate "edit"
// action, only a default app per file type and a list of other apps for
// it. So editing means: one of those other apps (Nemo's "Open With"), and
// for text-based files that open elsewhere by default (HTML in a browser),
// the default text editor, i.e. the default app for text/plain.
function populateContextMenu(button, menu) {
    let result = button.result;
    // For hits inside archives/mailboxes this is the container, like for Open.
    let file = Gio.File.new_for_path(result.path);
    let type = contentType(file);
    let defaultApp = type ? Gio.AppInfo.get_default_for_type(type, false) : null;
    let isDefault = app => defaultApp !== null && app.equal(defaultApp);

    menu.addMenuItem(new ContextMenuItem(button, "Open",
        "xsi-x-office-document-symbolic", () => openUri(result.url)));

    let editor = null;
    if (type && Gio.content_type_is_a(type, "text/plain")) {
        editor = Gio.AppInfo.get_default_for_type("text/plain", false);
        if (editor && isDefault(editor))
            editor = null;   // Open already uses it
    }
    if (editor) {
        menu.addMenuItem(new ContextMenuItem(button, "Edit as text",
            "xsi-document-edit-symbolic", () => launchApp(editor, file)));
    }

    let others = type ? Gio.AppInfo.get_recommended_for_type(type) : [];
    others = others
        .filter(app => !isDefault(app) && !(editor && app.equal(editor)))
        .slice(0, MAX_OPEN_WITH);
    for (let app of others) {
        menu.addMenuItem(new ContextMenuItem(button, `Open with ${app.get_name()}`,
            app.get_icon(), () => launchApp(app, file)));
    }

    menu.addMenuItem(new ContextMenuItem(button, "Open containing folder",
        "xsi-folder-open-symbolic", () => showInFolder(result)));
    menu.addMenuItem(new ContextMenuItem(button, "Copy path",
        "xsi-edit-copy-symbolic", () => copyPath(result)));
}

// The type the desktop uses for the file (may differ from Recoll's mtype).
function contentType(file) {
    try {
        return file.query_info("standard::content-type", Gio.FileQueryInfoFlags.NONE, null)
            .get_content_type();
    } catch (e) {
        return null;
    }
}

function launchApp(app, file) {
    try {
        app.launch([file], global.create_app_launch_context());
    } catch (e) {
        global.logError(`[recoll-search] could not start ${app.get_name()}: ${e.message}`);
    }
}

// Looks like the menu's own context menu items (ApplicationContextMenuItem).
// icon is a symbolic icon name, or an app's GIcon (shown in color).
class ContextMenuItem extends PopupMenu.PopupBaseMenuItem {
    constructor(button, label, icon, action) {
        super({ focusOnHover: false });
        this._button = button;
        this._action = action;

        if (typeof icon === "string") {
            this.addActor(new St.Icon({
                icon_name: icon,
                icon_size: 12,
                icon_type: St.IconType.SYMBOLIC,
            }));
        } else if (icon) {
            this.addActor(new St.Icon({ gicon: icon, icon_size: 12 }));
        }
        let labelActor = new St.Label({ text: label });
        this.addActor(labelActor);
        this.actor.set_label_actor(labelActor);
    }

    activate(event) {
        let applet = this._button.applet;
        applet.toggleContextMenu(this._button);
        applet.menu.close();
        this._action();
        return false;
    }
}

// Opens the folder with the file selected, through the file manager's
// org.freedesktop.FileManager1 interface (Nemo has it); without one, just
// opens the folder. For hits inside archives/mailboxes: the container.
function showInFolder(result) {
    Gio.DBus.session.call("org.freedesktop.FileManager1", "/org/freedesktop/FileManager1",
        "org.freedesktop.FileManager1", "ShowItems",
        new GLib.Variant("(ass)", [[result.url], ""]),
        null, Gio.DBusCallFlags.NONE, -1, null, (connection, res) => {
            try {
                connection.call_finish(res);
            } catch (e) {
                openUri(Gio.File.new_for_path(result.path).get_parent().get_uri());
            }
        });
}

function copyPath(result) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, result.path);
}

function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context());
    } catch (e) {
        global.logError(`[recoll-search] could not open ${uri}: ${e.message}`);
    }
}

// ---- "Search in Recoll" row -----------------------------------------------

function makeRecollRow(text, query) {
    return {
        id: RECOLL_ROW_ID,
        label: `Search “${text}” in Recoll…`,
        description: "Open the Recoll window with this search",
        query: query,
        type: "recoll",   // anything but "software" is shown by the menu
        icon: new St.Icon({
            gicon: Gio.ThemedIcon.new_from_names(["recoll", "system-search"]),
            icon_size: _config["icon-size"],
        }),
    };
}

function openRecoll(query) {
    let argv = [findProgram("recoll")];
    let confdir = confdirPath();
    if (confdir)
        argv.push("-c", confdir);
    argv.push("-q", query);   // query language, same as for recollq
    try {
        let proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        proc.wait_async(null, null);   // reap it when it exits
    } catch (e) {
        global.logError(`[recoll-search] failed to start recoll: ${e.message}`);
    }
}

// ---- Process handling -----------------------------------------------------

// Look up a program. A missing one is looked up again next time, so that
// installing Recoll works without restarting Cinnamon; it is logged once.
// (The extension shows a notification for a missing recollq.)
function findProgram(name) {
    if (!_programs[name]) {
        _programs[name] = GLib.find_program_in_path(name);
        if (!_programs[name] && !_missing.has(name)) {
            _missing.add(name);
            global.logError(`[recoll-search] ${name} not found; install the ` +
                            `'${name === "recoll" ? "recoll" : "recollcmd"}' package`);
        }
    }
    return _programs[name];
}

function cancelRunning() {
    if (_debounceId) {
        GLib.source_remove(_debounceId);
        _debounceId = 0;
    }
    if (_timeoutId) {
        GLib.source_remove(_timeoutId);
        _timeoutId = 0;
    }
    if (_cancellable) {
        _cancellable.cancel();
        _cancellable = null;
    }
}

// The menu does not tell providers when its search is cleared or the menu
// closes, and it adds results to its list whenever they arrive. While a
// search is active the search entry has the key focus, so drop the search
// if the focus is gone (menu closed) or the entry is empty (search cleared).
function searchStillActive() {
    let focus = global.stage.get_key_focus();
    if (!focus || focus instanceof Clutter.Stage)
        return false;
    if (focus instanceof Clutter.Text && focus.get_text().trim() === "")
        return false;
    return true;
}

// Runs recollq with the first of queries; if that fails, tries the next one
// (see buildQueries).
function runQuery(text, queries, generation, send) {
    let query = queries[0];
    let argv = buildArgv(query);
    let proc;
    try {
        proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        global.logError(`[recoll-search] failed to start recollq: ${e.message}`);
        return;
    }

    let cancellable = new Gio.Cancellable();
    _cancellable = cancellable;
    cancellable.connect(() => {
        try { proc.force_exit(); } catch (e) {}
    });

    _timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIMEOUT_MS, () => {
        _timeoutId = 0;
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });

    proc.communicate_utf8_async(null, cancellable, (p, res) => {
        let stdout;
        try {
            [, stdout] = p.communicate_utf8_finish(res);
        } catch (e) {
            // Cancelled (new keystroke, timeout, menu closed) or failed.
            return;
        }

        if (generation !== _generation)
            return;   // a newer search has started meanwhile

        if (_timeoutId) {
            GLib.source_remove(_timeoutId);
            _timeoutId = 0;
        }
        _cancellable = null;

        if (!searchStillActive())
            return;
        if (!p.get_successful()) {
            if (queries.length > 1)
                runQuery(text, queries.slice(1), generation, send);
            return;
        }

        let results = parseOutput(stdout || "");
        if (results.length === 0)
            return;
        results.forEach(addIcon);
        if (_config["show-recoll-row"] && findProgram("recoll"))
            results.unshift(makeRecollRow(text, query));
        results.forEach(setUpButton);

        try {
            send(results);
        } catch (e) {
            global.logError(e);
        }
    });
}

// ---- Search provider API (called by the menu) ----------------------------

function perform_search(pattern) {
    // Called as a method of this module; the search provider manager has just
    // attached a fresh send_results() for this search to it.
    let send = this.send_results;
    let generation = ++_generation;

    cancelRunning();
    loadConfig();

    let text = (pattern || "").trim();
    if (text.length < _config["min-chars"] || !findProgram("recollq"))
        return;

    let queries = buildQueries(text);
    if (queries.length === 0)
        return;

    _debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
        _debounceId = 0;
        if (generation === _generation && searchStillActive())
            runQuery(text, queries, generation, send);
        return GLib.SOURCE_REMOVE;
    });
}

function on_result_selected(result) {
    if (result.id === RECOLL_ROW_ID) {
        openRecoll(result.query);
        return;
    }

    // For hits inside archives/mailboxes this opens the container file.
    openUri(result.url);
}
