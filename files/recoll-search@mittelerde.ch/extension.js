// SPDX-License-Identifier: GPL-2.0-or-later
//
// Recoll file search for the Cinnamon menu.
//
// Cinnamon has no way for an extension to add results to the menu search,
// but it does load "search providers" listed in the gsettings key
// org.cinnamon enabled-search-providers from
// ~/.local/share/cinnamon/search_providers/<uuid>/.
//
// So this extension only installs the provider that ships in ./provider:
//   enable():  symlink ./provider into search_providers/ and add its uuid
//              to the key (Cinnamon then loads it)
//   disable(): remove the uuid (Cinnamon unloads it) and the symlink
//
// The settings belong to this extension; the provider reads the saved
// settings file (see provider/search_provider.js).
//
// A few seconds after enable() it also checks that Recoll is usable, and
// shows a notification if not, since the menu would just show no files.

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Main = imports.ui.main;
const Settings = imports.ui.settings;

const PROVIDER_UUID = "recoll-search-provider@mittelerde.ch";
const PROVIDERS_KEY = "enabled-search-providers";
const CHECK_DELAY_S = 5;     // don't add to the notifications at login

let _meta;
let _settings = null;
let _checkId = 0;
let _warned = false;         // warn at most once per Cinnamon session

function log(message) {
    global.log(`[recoll-search] ${message}`);
}

function logError(message) {
    global.logError(`[recoll-search] ${message}`);
}

// ---- Provider link --------------------------------------------------------

function providerTarget() {
    return GLib.build_filenamev([_meta.path, "provider"]);
}

function providerLink() {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [global.userdatadir, "search_providers", PROVIDER_UUID]));
}

// Returns the link's target, null if there is a file or directory that is
// not a symlink, or undefined if there is nothing.
function readLink(link) {
    try {
        let info = link.query_info("standard::is-symlink,standard::symlink-target",
                                   Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        return info.get_is_symlink() ? info.get_symlink_target() : null;
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return undefined;
        throw e;
    }
}

function linkProvider() {
    let link = providerLink();
    let target = providerTarget();
    let current = readLink(link);

    if (current === target)
        return true;
    if (current === null) {
        // Not ours (e.g. a manually installed copy); leave it alone.
        logError(`${link.get_path()} exists and is not a symlink; remove it and re-enable the extension`);
        return false;
    }
    if (current !== undefined)
        link.delete(null);   // stale link, e.g. the extension was moved

    try {
        link.get_parent().make_directory_with_parents(null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw e;
    }
    link.make_symbolic_link(target, null);
    log(`linked ${link.get_path()} -> ${target}`);
    return true;
}

function unlinkProvider() {
    let link = providerLink();
    if (readLink(link) === providerTarget())
        link.delete(null);
}

// ---- enabled-search-providers --------------------------------------------

function setProviderEnabled(enabled) {
    let list = global.settings.get_strv(PROVIDERS_KEY);
    let present = list.includes(PROVIDER_UUID);

    if (enabled && !present)
        list.push(PROVIDER_UUID);
    else if (!enabled && present)
        list = list.filter(uuid => uuid !== PROVIDER_UUID);
    else
        return;

    // Cinnamon watches this key and (un)loads the provider right away.
    global.settings.set_strv(PROVIDERS_KEY, list);
}

// ---- Recoll check ---------------------------------------------------------

function confdirArgs() {
    // The file chooser saves a URI; accept plain paths as well.
    let dir = _settings.getValue("recoll-confdir") || "";
    if (dir.startsWith("file://"))
        dir = Gio.File.new_for_uri(dir).get_path() || "";
    return dir ? ["-c", dir] : [];
}

function warn(details) {
    _warned = true;
    let icon = new St.Icon({
        gicon: new Gio.FileIcon({
            file: Gio.File.new_for_path(GLib.build_filenamev([_meta.path, "icon.png"])),
        }),
        icon_size: 48,
    });
    Main.warningNotify(_meta.name, details, icon);
}

function checkRecoll() {
    let recollq = GLib.find_program_in_path("recollq");
    if (!recollq) {
        warn("Recoll is not installed, so the menu shows no files. " +
             "Install it, e.g. with: sudo apt install recoll");
        return;
    }

    // A query for a plain word only fails if the index can't be opened.
    let argv = [recollq, ...confdirArgs(), "-n", "1", "recollsearchcheck"];
    try {
        let proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.wait_check_async(null, (p, res) => {
            try {
                p.wait_check_finish(res);
            } catch (e) {
                if (_settings)   // still enabled
                    warn("Recoll could not open its index, so the menu shows no files. " +
                         "Open Recoll once, or run 'recollindex', to create the index.");
            }
        });
    } catch (e) {
        logError(`could not run recollq: ${e.message}`);
    }
}

// ---- Extension API --------------------------------------------------------

function init(metadata) {
    _meta = metadata;
}

function enable() {
    // Creates the settings file on first use, so the provider finds it.
    _settings = new Settings.ExtensionSettings({}, _meta.uuid);

    try {
        if (linkProvider())
            setProviderEnabled(true);
    } catch (e) {
        logError(`could not install the search provider: ${e.message}`);
    }

    if (!_warned) {
        _checkId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CHECK_DELAY_S, () => {
            _checkId = 0;
            checkRecoll();
            return GLib.SOURCE_REMOVE;
        });
    }
}

function disable() {
    if (_checkId) {
        GLib.source_remove(_checkId);
        _checkId = 0;
    }

    try {
        setProviderEnabled(false);
        unlinkProvider();
    } catch (e) {
        logError(`could not remove the search provider: ${e.message}`);
    }

    if (_settings) {
        _settings.finalize();
        _settings = null;
    }
}
