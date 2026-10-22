# Recoll file search for the Cinnamon menu

A Cinnamon extension that adds files from your [Recoll](https://www.recoll.org/)
index to the search results of the **stock** Cinnamon menu. It matches file
names and file contents, including files inside zip archives and mailboxes.

## Requirements

- Cinnamon 6.0 or newer (developed and tested on 6.6)
- `recollq`, from the `recollcmd` package (installed along with `recoll`)
- An existing Recoll index (run `recollindex` once, or let the Recoll GUI build it)

## Install

```sh
./install.sh
```

This copies the extension to `~/.local/share/cinnamon/extensions/` and
enables it. Remove it again with `./install.sh --remove`, or disable it in
System Settings → Extensions.

## Use

Open the menu and type at least 3 characters. File results appear below
the app results:

- **label**: file name (for hits inside an archive: the member's name)
- **second line**: the folder, as `~/...` inside your home folder, otherwise
  the full path; long paths are shortened in the middle. Shown like the app
  descriptions, so only if the menu's "Show application descriptions" is on.
- **icon**: the file type icon with a small magnifier badge
- **Enter / click**: opens the file with its default app; hits inside an
  archive open the archive
- **Right-click / Menu key / Ctrl+Enter**: context menu with *Open*,
  *Open containing folder* (opens the folder in the file manager with the
  file selected) and *Copy path*

Several words must all match (each by content or by file name). Words are
matched as prefixes ("inv" finds "invoice"). Very short prefixes can match
more words than Recoll allows (`maxTermExpand`, 10000 by default); then the
search falls back to whole words for the content, and if needed to whole
words only.

## Settings

System Settings → Extensions → Recoll file search → settings:

| Setting                                 | Default | Meaning                                        |
|-----------------------------------------|---------|------------------------------------------------|
| Maximum number of file results          | 15      | file results shown                             |
| Start searching after                   | 3       | shorter input is not searched                  |
| Show hits inside archives and mailboxes | on      | include zip members, mails in mbox files, ...  |
| Icon size                               | 32      | match the menu's "Application icon size"       |
| Mark file results with a search badge   | on      | small magnifier on file icons, to tell them apart from apps |
| Show a "Search in Recoll" row           | off     | extra row above the files that opens the Recoll window with the same search (needs the `recoll` package) |
| Recoll configuration folder             | empty   | use a non-default Recoll configuration         |

Changes apply to the next search; no restart needed.

Which folders are indexed, and how often, is configured in Recoll itself
(`recoll` → Preferences → Index configuration). For results that stay
current, enable real-time indexing (Preferences → Indexing schedule), or run
`recollindex` from cron.

## How it works

Cinnamon has no API for extensions to add menu search results. It does
have *search providers*: modules in `~/.local/share/cinnamon/search_providers/`
that the menu queries if their uuid is listed in the gsettings key
`org.cinnamon enabled-search-providers`. Search providers can't be
installed from Spices and have no settings UI, so this extension wraps one:

- `files/recoll-search@mittelerde.ch/provider/` is the search provider
  (uuid `recoll-search-provider@mittelerde.ch`). It runs `recollq` and turns
  its output into menu results.
- `extension.js`, when enabled, symlinks `provider/` into
  `search_providers/` and adds its uuid to `enabled-search-providers`.
  When disabled, it removes both again. Other enabled providers are kept.
- The settings belong to the extension. The provider reads them from
  `~/.config/cinnamon/spices/recoll-search@mittelerde.ch/recoll-search@mittelerde.ch.json`.

## Troubleshooting

If Recoll is not installed, or its index can't be opened, the extension
shows a notification a few seconds after it is enabled (at most once per
session). After installing Recoll, results appear without a restart.

Open Looking Glass (Alt+F2, type `lg`, Enter) and check the *Log* tab for
lines starting with `[recoll-search]`, or errors mentioning
`recoll-search@mittelerde.ch` / `recoll-search-provider@mittelerde.ch`.

Check that the provider is set up:

```sh
gsettings get org.cinnamon enabled-search-providers   # contains recoll-search-provider@mittelerde.ch
ls -l ~/.local/share/cinnamon/search_providers/        # symlink into the extension
```

Check the query on the command line, e.g.:

```sh
recollq -C -n 15 'invoice* OR filename:invoice*'
```

## Known limitations

- File results are appended after the app results, without a section header
  (the badge and the optional "Search in Recoll" row mark them instead).
- If no app matches, the menu selects the first file result; with the
  "Search in Recoll" row on, that is the row, so Enter opens Recoll.
- The context menu relies on how the stock menu builds its result buttons
  (Cinnamon has no API for it). If a future Cinnamon changes that, results
  still work, just without the context menu.
- With "Show hits inside archives and mailboxes" off, fewer results than the
  maximum may be shown, because hidden hits still count towards the number
  of results fetched from Recoll.
- Only menus that use Cinnamon's search providers show results (the stock
  menu does).

## License

GPL-2.0-or-later, see [LICENSE](LICENSE).
