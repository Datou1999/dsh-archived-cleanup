# Archived cleanup

Archiving in DeepSeek Harness only hides a Session from the sidebar: the log keeps
its full size under `~/.dsh/sessions`. The harness ships no "delete Session" action,
so this bundle adds one, scoped to archived Sessions only.

## Where it lives

Settings → **Archived cleanup**. The page lists every id currently in the
workspace registry's archive set, grouped by workspace, with its title, last update,
on-disk size, and how many subagent Sessions it owns.

## How to delete

1. Tick the Sessions you want gone (or **Select all**).
2. Press **Delete selected…** and confirm.
3. Every selected Session is copied into `~/.dsh/cleanup-backups/cleanup-backup-<timestamp>/`
   first, with a `manifest.json` that records each original path, its files, sizes,
   and the `workspace.json` hash.
4. Only after the backup completes does the bundle remove
   `sessions/<project>/<id>/` and `storages/session_projcache/<id>.json`, then drop
   the id from each workspace's account list and from the archive set.

Subagent Sessions whose `parentSession` chain reaches a selected archived Session are
removed together with it; the page shows how many that will be before you confirm.

## What it refuses to do

- A Session that is not archived is skipped (`not-archived`).
- A Session the host currently has loaded or running is skipped (`in-use`).
- A directory that does not resolve below the sessions root is skipped (`outside-root`).
- If the backup fails, nothing at all is deleted and the request fails with
  `backup-failed`.

The result line reports deleted Sessions, freed bytes, the backup directory, and any
skipped or failed ids individually.

## Opening the backup folder

**Open backup folder** in the toolbar shows `~/.dsh/cleanup-backups` in the OS
file manager; **Open** next to a row in *Recent backups* jumps to that backup.
The Host only accepts names inside that root — `..` and absolute paths answer
`invalid-backup`.

## Restoring a backup

0. Use **Open backup folder** in the toolbar, or **Open** on a backup row.
1. Copy `cleanup-backup-<timestamp>/sessions/<project>/<id>/` back to
   `~/.dsh/sessions/<project>/<id>/`.
2. Copy `cleanup-backup-<timestamp>/session_projcache/<id>.json` back to
   `~/.dsh/storages/session_projcache/`.
3. Restore `workspace.json` from the same backup directory (it matches the archived
   set at backup time), then restart DeepSeek Harness.

## Notes

- The derived search index is rebuilt from session persistence, so a deleted Session
  disappears from search on the next list or query; nothing else needs cleaning.
- The page reads titles and workspace names from the Client's own snapshots, so it
  never parses session logs.
- Routes are served at `/archived-cleanup/*` on the web server and at
  `/api/archived-cleanup/*` through the Desktop Connection carrier, both behind the
  harness's browser trust fence.
