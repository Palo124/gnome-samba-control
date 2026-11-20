# Samba Control

Manage the local Samba file server from the GNOME top bar. The extension shows the current status of `smbd.service` and whether it is enabled at startup.

## Features

- Start, stop, restart, or reload Samba and control whether it starts at boot.
- View configured shares and active SMB sessions.
- Validate the Samba configuration and view up to 10 recent service log entries.
- Choose from eight top-bar icons with a preview, and adjust the icon's section and position.

## Requirements

- [metadata.json](metadata.json) lists GNOME Shell 46–49 as the target range. The extension was tested only on GNOME Shell 46.0 on the author's machine.
- A local Samba installation managed by systemd as `smbd.service`.
- `systemctl`, `journalctl`, `testparm`, `smbstatus`, and `pkexec` at their standard `/usr/bin` paths. Session viewing requires a Samba version that supports `smbstatus --json`.
- The `gnome-extensions` and `glib-compile-schemas` commands for installation. A running Polkit authentication agent is required for privileged actions.

## Install from source

Clone the repository, then copy the extension into your user data directory and compile its settings schema.

```bash
git clone https://github.com/Palo124/gnome-samba-control.git
cd gnome-samba-control
```

```bash
extension_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/samba-control@palo124"
mkdir -p "$extension_dir/schemas" &&
    cp metadata.json extension.js prefs.js "$extension_dir/" &&
    cp schemas/*.gschema.xml "$extension_dir/schemas/" &&
    glib-compile-schemas --strict "$extension_dir/schemas"
```

Log out and back in so GNOME Shell loads the installed files. Then enable the extension from the **Extensions** app or run:

```bash
gnome-extensions enable samba-control@palo124
```

To update, pull the latest changes in your checkout, repeat the copy and schema compilation steps, and log out and back in.

## Use Samba Control

Open the shared-folder icon in the top bar.

- **Service controls** manages the running service and its boot setting. **Enable at boot** and **Disable at boot** affect future boots. Stopping or restarting Samba can interrupt active transfers.
- **Configured shares** lists shares from the Samba configuration.
- **Active sessions** lets you refresh session details or choose **Authenticate to read sessions** if your user has limited access. After authenticating, reopen the menu to see the result.
- **Diagnostics** runs `testparm` and shows recent service logs that your user can read.
- **Preferences** lets you choose an icon and place it in the left, center, or right section of the top bar. Position 1 puts it first in that section. A position beyond the available slots puts it last. Changes apply immediately and are saved across sessions.

You can also open preferences with `gnome-extensions prefs samba-control@palo124`.

## Permissions

Service changes and authenticated session reads use `pkexec`. The system Polkit agent handles authentication. Your Polkit configuration determines when to prompt. Session details may include usernames and client addresses.

## Troubleshooting

Check whether GNOME recognizes the extension, whether Samba's systemd unit is available, and whether the required tools are installed.

```bash
gnome-extensions info samba-control@palo124
systemctl status smbd.service
command -v pkexec smbstatus testparm journalctl systemctl
journalctl --user -b -o cat | grep -iE 'samba-control|samba control'
```
