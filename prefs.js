import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const ICONS = [
    ['Shared folder', 'folder-publicshare-symbolic'],
    ['Remote folder', 'folder-remote-symbolic'],
    ['Network server', 'network-server-symbolic'],
    ['Network workgroup', 'network-workgroup-symbolic'],
    ['Network computer', 'network-computer-symbolic'],
    ['Wired network', 'network-wired-symbolic'],
    ['Storage drive', 'drive-harddisk-symbolic'],
    ['Folder', 'folder-symbolic'],
];

function choiceRow(settings, key, title, choices) {
    const current = settings.get_string(key);
    const selected = choices.findIndex(([, value]) => value === current);
    const options = selected < 0 ? [...choices, [current, current]] : choices;
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(options.map(([label]) => label)),
        selected: selected < 0 ? choices.length : selected,
    });
    row.connect('notify::selected', () => {
        settings.set_string(key, options[row.selected][1]);
    });
    return row;
}

export default class SambaControlPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({title: 'Top bar'});
        window.add(page);
        page.add(group);

        const icon = choiceRow(settings, 'icon-name', 'Icon', ICONS);
        const preview = new Gtk.Image({pixel_size: 20});
        settings.bind('icon-name', preview, 'icon-name', Gio.SettingsBindFlags.GET);
        icon.add_prefix(preview);
        group.add(icon);

        group.add(choiceRow(settings, 'panel-section', 'Section', [
            ['Left', 'left'],
            ['Center', 'center'],
            ['Right', 'right'],
        ]));

        const [minimum, maximum] = settings.settings_schema
            .get_key('panel-position').get_range().deep_unpack()[1].deep_unpack();
        const position = Adw.SpinRow.new_with_range(minimum, maximum, 1);
        position.title = 'Position in section';
        position.subtitle = '1 places the icon first. Higher values move it toward the end.';
        settings.bind('panel-position', position, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(position);
    }
}
