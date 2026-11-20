# Samba Control (GNOME Shell 46–49 source target)

A minimal, locally installed extension. It uses a fixed `smbd.service` target.

## Installation

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/samba-control@local
cp -r metadata.json extension.js prefs.js schemas ~/.local/share/gnome-shell/extensions/samba-control@local/
glib-compile-schemas --strict ~/.local/share/gnome-shell/extensions/samba-control@local/schemas
gnome-extensions disable samba-control@local 2>/dev/null || true
gnome-extensions enable samba-control@local
```

If GNOME doesn't discover a new extension, log out and back in, then enable it.

## Top-bar preferences

Open **Preferences** from the Samba Control menu or run `gnome-extensions prefs samba-control@local`.
Choose an icon, a panel section, and a position within that section. Position 1 puts the icon first in the section, and positions beyond the available slots put it last. Changes are saved and applied immediately.

## Privilege model

- Reading systemd service state, testparm, and regular journal output requires no elevation.
- Every service modification executes `/usr/bin/pkexec /usr/bin/systemctl ACTION smbd.service`.
- Authenticated sessions explicitly execute `/usr/bin/pkexec /usr/bin/smbstatus --json`.
- No password is accepted or stored by this extension. The system Polkit agent handles authentication.
- No sudoers, auth-bypass Polkit rules, shell commands, or elevated user-writable helper scripts.
- Polkit may cache authentication temporarily according to your system policies. A new prompt **for each** operation is therefore not guaranteed.
- Samba session metadata contains usernames and client addresses. Display it only on a trusted desktop.
- Inactive Samba connections may not always be visible from unprivileged `smbstatus`. Use the authenticated read if needed.
- GNOME Shell extensions run *inside GNOME Shell*. Avoid placing broad config mutation powers here.

## Known limitations

- Not tested in your particular Ubuntu/GNOME environment. Verify `gnome-shell --version` and executable paths (`command -v pkexec smbstatus testparm journalctl systemctl`).
- If the Polkit agent isn't registered, service actions fail rather than opening a password dialog.
- `/usr/bin/smbstatus` and `/usr/bin/testparm` are typical Ubuntu paths but may differ.
- 'Enable at boot' and 'Disable at boot' do not change the current running state.
- Logs are unprivileged and may be incomplete.
- No SMB user management, share editing, ACL modification, or disconnect-client features. Those require a separate privileged backend with narrowly scoped operations, validation, and backup/rollback.
- Starting/Stopping/restarting `smbd` can interrupt active transfers.
- Extension is targeted at GNOME 46–49 APIs. Listed versions are not a test guarantee.

## Debugging

```bash
journalctl --user -b -o cat | grep -i 'samba control'
systemctl is-active smbd.service
systemctl is-enabled smbd.service
command -v pkexec smbstatus testparm
```

## Sessions UI behavior (fixed)

- Open **Active sessions** and explicitly choose **Refresh sessions** or **Authenticate to read sessions**.
- Password prompt is managed by Polkit; after authenticating, reopen the menu to read the results.
- Opening or closing the menu no longer resets or overwrites the previous authenticated result.
- The view distinguishes 0 sessions, command failures, missing JSON, and parsing errors.
- A successful authenticated read does **not** imply active clients exist.

To verify, compare `sudo smbstatus --json` in a terminal while an SMB client is actually connected.
