import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

// Fixed, unprivileged systemd targets. Never interpolate user-supplied input
// into privileged commands; do not use a shell or chmod/setuid helper.
const SERVICE = 'smbd.service';
const SYSTEMCTL = '/usr/bin/systemctl';
const PKEXEC = '/usr/bin/pkexec';
const REFRESH_SECONDS = 10;

async function run(argv, cancellable = null) {
    const proc = Gio.Subprocess.new(
        argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
    );
    const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
    return {
        ok: proc.get_successful(),
        stdout: (stdout ?? '').trim(),
        stderr: (stderr ?? '').trim(),
        exitCode: proc.get_exit_status(),
    };
}

function infoItem(menu, label) {
    const item = new PopupMenu.PopupMenuItem(label, {reactive: false});
    menu.addMenuItem(item);
    return item;
}

function addAction(menu, label, fn) {
    const item = new PopupMenu.PopupMenuItem(label);
    item.connect('activate', fn);
    menu.addMenuItem(item);
    return item;
}

function message(error) {
    return String(error?.message ?? error).replaceAll('\n', ' ').slice(0, 160);
}

export default class SambaControl extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._sessionRequestId = 0;
        this._enabled = true;
        this._busy = false;
        this._generation = 0;
        this._reading = false;
        this._timer = 0;

        this._indicator = new PanelMenu.Button(0.0, 'Samba Control');
        this._icon = new St.Icon({
            style_class: 'system-status-icon',
        });
        this._settings.bind('icon-name', this._icon, 'icon-name',
            Gio.SettingsBindFlags.GET);
        this._indicator.add_child(this._icon);

        this._status = infoItem(this._indicator.menu, 'Samba: checking…');
        this._boot = infoItem(this._indicator.menu, 'Startup: checking…');
        this._feedback = infoItem(this._indicator.menu, '');
        this._feedback.actor.hide();

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._serviceMenu = new PopupMenu.PopupSubMenuMenuItem('Service controls');
        this._indicator.menu.addMenuItem(this._serviceMenu);
        this._actions = new Map();
        for (const [label, action] of [
            ['Start', 'start'],
            ['Stop', 'stop'],
            ['Restart', 'restart'],
            ['Reload', 'reload'],
            ['Enable at boot', 'enable'],
            ['Disable at boot', 'disable'],
        ]) {
            this._actions.set(action, addAction(this._serviceMenu.menu, label,
                () => { void this._runServiceAction(action); }));
        }

        this._sessionsMenu = new PopupMenu.PopupSubMenuMenuItem('Active sessions');
        this._indicator.menu.addMenuItem(this._sessionsMenu);
        addAction(this._sessionsMenu.menu, 'Refresh sessions',
            () => { void this._loadSessions(false); });
        addAction(this._sessionsMenu.menu, 'Authenticate to read sessions',
            () => { void this._loadSessions(true); });
        this._sessionsMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._sessionsInfo = infoItem(this._sessionsMenu.menu, 'Select Refresh or Authenticate to inspect');

        this._sharesMenu = new PopupMenu.PopupSubMenuMenuItem('Configured shares');
        this._indicator.menu.addMenuItem(this._sharesMenu);
        addAction(this._sharesMenu.menu, 'Refresh shares',
            () => { void this._loadShares(); });
        this._sharesMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._sharesInfo = infoItem(this._sharesMenu.menu, 'Open to inspect');

        this._diagMenu = new PopupMenu.PopupSubMenuMenuItem('Diagnostics');
        this._indicator.menu.addMenuItem(this._diagMenu);
        addAction(this._diagMenu.menu, 'Validate Samba configuration',
            () => { void this._validateConfig(); });
        addAction(this._diagMenu.menu, 'Show recent service logs',
            () => { void this._loadLogs(); });
        this._diagMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._diagInfo = infoItem(this._diagMenu.menu, 'Select an action');

        // All status probes are unprivileged. The privilege prompt is only
        // invoked after an explicit user action.
        this._sharesMenu.menu.connect('open-state-changed', (_menu, open) => {
            if (open) void this._loadShares();
        });
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open) void this._refresh();
        });

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        addAction(this._indicator.menu, 'Preferences', () => this.openPreferences());

        Main.panel.addToStatusArea('samba-control', this._indicator);
        this._updatePanelPosition();
        this._positionSignals = ['panel-section', 'panel-position'].map(key =>
            this._settings.connect(`changed::${key}`, () => this._updatePanelPosition()));
        void this._refresh();
        this._timer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            REFRESH_SECONDS,
            () => {
                if (!this._busy) void this._refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _updatePanelPosition() {
        const boxes = {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox,
        };
        const box = boxes[this._settings.get_string('panel-section')];
        const position = this._settings.get_int('panel-position');
        const container = this._indicator.container;
        const parent = container.get_parent();
        if (parent === box && box.get_child_at_index(position - 1) === container)
            return;

        this._indicator.menu.close();
        parent.remove_child(container);
        box.insert_child_at_index(container, Math.min(position - 1, box.get_n_children()));
    }

    _setFeedback(text) {
        if (!this._enabled) return;
        this._feedback.label.text = text;
        if (text) this._feedback.actor.show();
        else this._feedback.actor.hide();
    }

    _updateActions(state, boot) {
        for (const [action, item] of this._actions) {
            let allowed = !this._busy;
            if (action === 'start') allowed &&= state !== 'active';
            if (action === 'stop') allowed &&= state === 'active';
            if (action === 'restart' || action === 'reload')
                allowed &&= state === 'active';
            if (action === 'enable') allowed &&= boot !== 'enabled';
            if (action === 'disable') allowed &&= boot === 'enabled';
            item.setSensitive(allowed);
        }
    }

    async _refresh() {
        if (!this._enabled || this._reading || this._busy) return;
        this._reading = true;
        const generation = this._generation;
        try {
            const [stateResult, bootResult] = await Promise.all([
                run([SYSTEMCTL, 'is-active', SERVICE]),
                run([SYSTEMCTL, 'is-enabled', SERVICE]),
            ]);
            if (!this._enabled || generation !== this._generation) return;
            // is-active/is-enabled return nonzero for ordinary inactive/disabled states.
            const state = stateResult.stdout || 'unknown';
            const boot = bootResult.stdout || 'unknown';
            const color = state === 'active' ? '#2ecc71'
                : (state === 'inactive' || state === 'failed' ? '#e74c3c' : '#e5a50a');
            this._status.label.text = `Samba: ${state}`;
            this._status.label.set_style(`color: ${color};`);
            this._icon.set_style(`color: ${color};`);
            this._boot.label.text = `Startup: ${boot}`;
            this._updateActions(state, boot);
        } catch (error) {
            if (!this._enabled || generation !== this._generation) return;
            this._status.label.text = `Samba: ${message(error)}`;
            this._status.label.set_style('color: #e5a50a;');
            this._icon.set_style('color: #e5a50a;');
            this._updateActions('unknown', 'unknown');
        } finally {
            this._reading = false;
        }
    }

    async _runServiceAction(action) {
        if (!this._enabled || this._busy) return;
        this._busy = true;
        this._generation++;
        this._updateActions('unknown', 'unknown');
        this._setFeedback(`${action}: requesting authorization…`);
        try {
            // pkexec requests authentication via the desktop Polkit agent.
            // The executable is system-owned, not a user-writable script.
            const result = await run([PKEXEC, SYSTEMCTL, action, SERVICE]);
            if (!this._enabled) return;
            this._setFeedback(result.ok
                ? `${action}: completed`
                : `${action}: ${result.stderr || `exit ${result.exitCode}`}`);
        } catch (error) {
            this._setFeedback(`${action}: ${message(error)}`);
        } finally {
            this._busy = false;
            if (this._enabled) void this._refresh();
        }
    }

    async _loadSessions(authenticated) {
        if (!this._enabled) return;

        // Only the newest user-requested read may update the menu. Crucially,
        // opening the submenu must NOT start a competing unprivileged read.
        const requestId = ++this._sessionRequestId;
        this._sessionsInfo.label.text = authenticated
            ? 'Waiting for authentication…'
            : 'Reading sessions…';
        try {
            const argv = authenticated
                ? [PKEXEC, '/usr/bin/smbstatus', '--json']
                : ['/usr/bin/smbstatus', '--json'];
            const result = await run(argv);
            if (!this._enabled || requestId !== this._sessionRequestId) return;

            if (!result.ok) {
                // Surface the real failure, rather than claiming authentication
                // failed just because an unprivileged read was denied.
                const reason = result.stderr || `exit ${result.exitCode}`;
                this._sessionsInfo.label.text = authenticated
                    ? `Sessions failed: ${reason.slice(0, 100)}`
                    : `Read failed: ${reason.slice(0, 85)} (try Authenticate)`;
                console.error(`Samba Control: smbstatus: ${reason}`);
                return;
            }

            if (!result.stdout) {
                this._sessionsInfo.label.text = 'No JSON returned by smbstatus';
                return;
            }

            const payload = JSON.parse(result.stdout);
            if (!payload || typeof payload !== 'object' ||
                !payload.sessions || typeof payload.sessions !== 'object') {
                this._sessionsInfo.label.text = 'No sessions field in Samba JSON';
                console.error('Samba Control: smbstatus JSON missing sessions');
                return;
            }

            const sessions = Array.isArray(payload.sessions)
                ? payload.sessions : Object.values(payload.sessions);

            for (const child of this._sessionDetails ?? []) child.destroy();
            this._sessionDetails = [];

            this._sessionsInfo.label.text = sessions.length === 0
                ? 'No active SMB sessions'
                : `${sessions.length} active SMB session(s)`;

            for (const session of sessions.slice(0, 8)) {
                const user = String(session.username ?? session.user ?? 'unknown');
                const host = String(session.remote_machine ?? session.hostname ??
                    session.remote_address ?? 'unknown');
                this._sessionDetails.push(infoItem(this._sessionsMenu.menu,
                    `${user.slice(0, 24)} @ ${host.slice(0, 36)}`));
            }
            if (sessions.length > 8)
                this._sessionDetails.push(infoItem(this._sessionsMenu.menu,
                    `…and ${sessions.length - 8} more`));
        } catch (error) {
            if (!this._enabled || requestId !== this._sessionRequestId) return;
            this._sessionsInfo.label.text = `Sessions error: ${message(error)}`;
            console.error(`Samba Control sessions: ${error?.stack || error}`);
        }
    }

    async _loadShares() {
        if (!this._enabled) return;
        this._sharesInfo.label.text = 'Loading shares…';
        try {
            // testparm -s is read-only, but its printed config may be sensitive.
            const result = await run(['/usr/bin/testparm', '-s']);
            if (!this._enabled) return;
            if (!result.ok) {
                this._sharesInfo.label.text = `testparm: ${result.stderr || 'failed'}`.slice(0, 120);
                return;
            }
            const shares = [...result.stdout.matchAll(/^\s*\[([^\]]+)\]\s*$/gm)]
                .map(match => match[1])
                .filter(name => name.toLowerCase() !== 'global');
            this._sharesInfo.label.text = `${shares.length} configured share(s)`;
            for (const child of this._shareDetails ?? []) child.destroy();
            this._shareDetails = shares.slice(0, 12).map(name =>
                infoItem(this._sharesMenu.menu, name.slice(0, 65)));
            if (shares.length > 12)
                this._shareDetails.push(infoItem(this._sharesMenu.menu,
                    `…and ${shares.length - 12} more`));
        } catch (error) {
            if (this._enabled) this._sharesInfo.label.text = `Shares: ${message(error)}`;
        }
    }

    async _validateConfig() {
        this._diagInfo.label.text = 'Validating…';
        try {
            const result = await run(['/usr/bin/testparm', '-s']);
            if (!this._enabled) return;
            this._diagInfo.label.text = result.ok
                ? 'Configuration: valid (testparm passed)'
                : `Configuration: ${result.stderr || 'invalid'}`.slice(0, 140);
        } catch (error) {
            if (this._enabled) this._diagInfo.label.text = message(error);
        }
    }

    async _loadLogs() {
        this._diagInfo.label.text = 'Reading service logs…';
        try {
            const result = await run([
                '/usr/bin/journalctl', '-u', SERVICE, '-n', '10',
                '--no-pager', '--output=short',
            ]);
            if (!this._enabled) return;
            for (const child of this._logDetails ?? []) child.destroy();
            this._logDetails = [];
            if (!result.ok) {
                this._diagInfo.label.text = `Logs: ${result.stderr || 'unavailable'}`.slice(0, 120);
                return;
            }
            const lines = result.stdout.split('\n').filter(Boolean);
            this._diagInfo.label.text = `Recent logs (${lines.length} line(s); may be restricted)`;
            this._logDetails = lines.slice(-10).map(line =>
                infoItem(this._diagMenu.menu, line.slice(0, 100)));
        } catch (error) {
            if (this._enabled) this._diagInfo.label.text = `Logs: ${message(error)}`;
        }
    }

    disable() {
        for (const id of this._positionSignals ?? [])
            this._settings.disconnect(id);
        this._positionSignals = null;
        this._settings = null;
        this._enabled = false;
        this._generation++;
        this._sessionRequestId++;
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._icon = null;
        this._actions = null;
        this._sessionsInfo = null;
        this._sharesInfo = null;
        this._diagInfo = null;
    }
}
