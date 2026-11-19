// SPDX-License-Identifier: GPL-3.0-or-later
/* quickToggle.js: the headphones' tile in the quick settings, and its menu.
 * Nothing goes on the panel.
 *
 * The menu reads the buds and their case as a row of three columns, ruled
 * apart: each part's glyph over its level, and under them its own bar, the
 * case's a little shorter. Under that, the noise control modes share one
 * track, where the accent pill slides to the mode picked; noise cancelling's
 * levels get a smaller track of their own.
 *
 * Nothing scrolls the quick settings, so on a short screen a tall menu runs
 * off the bottom. Everything under the menu's header scrolls instead, given
 * only the room the screen has left. Bluetooth Settings is a button in the
 * header's corner. */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {boxOrientation} from './compat.js';

/* At or below, a level turns red. */
const LOW_BATTERY = 20;
/* A level that is not live: the shut case's earlier one, or none at all. */
const DIM_OPACITY = 130;
/* Each bar's share of its column's width. The case's is narrower: it holds
 * the buds, and reads quieter than they do. */
const BAR_SPAN = 0.64;
const CASE_BAR_SPAN = 0.47;
/* A charging bar's glow, swelling or fading. */
const GLOW_MS = 1200;
/* Opened from the button in the menu's header. */
const SETTINGS_APP = 'gnome-bluetooth-panel.desktop';
/* The accent pill's slide to a newly picked mode. */
const SLIDE_MS = 200;
/* The least the scrolling middle of the menu is given, in logical pixels,
 * however short the screen: less would show too little to scroll through. */
const MIN_SCROLL_HEIGHT = 120;

const PART_ICONS = {
    left: 'earbud-left-symbolic',
    right: 'earbud-right-symbolic',
    case: 'earbuds-case-symbolic',
};

/* Immersion and Cinema are noise cancelling with spatial audio. */
const MODE_ICONS = {
    off: 'noise-off-symbolic',
    transparency: 'noise-transparency-symbolic',
    nc: 'noise-cancelling-symbolic',
    adaptive: 'noise-adaptive-symbolic',
    wind: 'noise-wind-symbolic',
    immersion: 'noise-cancelling-symbolic',
    cinema: 'noise-cancelling-symbolic',
};

/* Bundled, since no stock symbolic icon draws an earbud or a noise mode. The
 * `-symbolic.svg` name makes St recolor them like theme icons. */
function bundledIcon(name) {
    return new Gio.FileIcon({
        file: Gio.File.new_for_uri(import.meta.url).get_parent()
            .resolve_relative_path(`icons/${name}.svg`),
    });
}

/* Labels are looked up when used: gettext needs the extension object, which
 * does not exist yet while this module loads. */
function partLabel(part) {
    switch (part) {
    case 'left':
        return _('Left');
    case 'right':
        return _('Right');
    case 'case':
        return _('Case');
    default:
        return _('Battery');
    }
}

/* Short, for the switcher's buttons. */
function modeLabel(mode) {
    switch (mode) {
    case 'off':
        return _('Off');
    case 'transparency':
        return _('Transparency');
    case 'adaptive':
        return _('Adaptive');
    case 'wind':
        return _('Wind');
    case 'immersion':
        return _('Immersion');
    case 'cinema':
        return _('Cinema');
    default:
        /* Translators: active noise cancelling, on a narrow button. */
        return _('ANC');
    }
}

function levelLabel(level) {
    switch (level) {
    case 'light':
        return _('Light');
    case 'medium':
        return _('Medium');
    case 'deep':
        return _('Deep');
    default:
        return _('Smart');
    }
}

function percent(level) {
    /* Translators: a battery level; %d is the number,   a thin space. */
    return _('%d %%').format(level);
}

/* What the buds are doing, in words, or null before they say. */
function noiseSummary(noise) {
    switch (noise?.mode) {
    case 'off':
        return _('Noise Control Off');
    case 'transparency':
        return _('Transparency');
    case 'adaptive':
        return _('Adaptive Noise Cancelling');
    case 'wind':
        return _('Wind Noise Reduction');
    case 'immersion':
        return _('Immersion');
    case 'cinema':
        return _('Cinema');
    case 'nc':
        if (noise.levels.length < 2)
            return _('Noise Cancelling');
        switch (noise.level) {
        case 'light':
            return _('Light Noise Cancelling');
        case 'medium':
            return _('Medium Noise Cancelling');
        case 'deep':
            return _('Deep Noise Cancelling');
        case 'smart':
            return _('Smart Noise Cancelling');
        default:
            return _('Noise Cancelling');
        }
    default:
        return null;
    }
}

function setClass(actor, name, on) {
    if (on)
        actor.add_style_class_name(name);
    else
        actor.remove_style_class_name(name);
}

/* A rounded bar filled from its start to a fraction of its track. The track
 * takes a share of the bar's width, centred in it. While its part charges, a
 * glow swells toward the end of the fill and fades, over and over. */
const LevelBar = GObject.registerClass(
class LevelBar extends St.Widget {
    _init(span) {
        super._init({style_class: 'hc-level', x_expand: true});
        this._span = span;
        this._fraction = 0;

        this._track = new St.Widget({style_class: 'hc-bar'});
        this._fill = new St.Widget({style_class: 'hc-bar-fill'});
        this._glow = new St.Widget({style_class: 'hc-bar-glow', visible: false});
        this.add_child(this._track);
        this.add_child(this._fill);
        this.add_child(this._glow);

        /* Glows only while it can be seen: from when the glow itself is
         * mapped, as the bar is mapped before its children are, and an ease
         * on an unmapped actor jumps straight to its end. */
        this._glow.connect('notify::mapped', () => this._animateGlow());
    }

    setLevel(fraction, {charging, low}) {
        fraction = Math.clamp(fraction, 0, 1);
        if (fraction !== this._fraction) {
            this._fraction = fraction;
            this.queue_relayout();
        }
        setClass(this, 'hc-low', low);
        this._glow.visible = charging;
    }

    _animateGlow() {
        const glow = this._glow;
        glow.remove_all_transitions();
        if (!glow.mapped)
            return;

        /* With animations off, it stays lit. */
        if (!St.Settings.get().enable_animations) {
            glow.opacity = 255;
            return;
        }
        glow.opacity = 0;
        glow.ease({
            opacity: 255,
            duration: GLOW_MS,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            autoReverse: true,
            repeatCount: -1,
        });
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const width = content.x2 - content.x1;

        const track = content.copy();
        const trackWidth = Math.round(width * this._span);
        track.x1 = content.x1 + Math.round((width - trackWidth) / 2);
        track.x2 = track.x1 + trackWidth;
        this._track.allocate(track);

        const fill = track.copy();
        fill.x2 = fill.x1 + Math.round(trackWidth * this._fraction);
        this._fill.allocate(fill);
        this._glow.allocate(fill);
    }
});

/* One part of the meter, in a column of its own: the part's glyph over its
 * level, centred, and the level's bar under them. A rule at the start edge
 * parts it from the column before. */
const PartColumn = GObject.registerClass(
class PartColumn extends St.BoxLayout {
    _init(barSpan) {
        super._init({
            style_class: 'hc-column',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
        });

        this._part = null;

        /* The rule lies over the readout's start edge, as tall as it. */
        const top = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._readout = new St.BoxLayout({
            style_class: 'hc-readout',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
        });
        /* Expanding, or the bin gives it only its natural size, centred. */
        this._rule = new St.Widget({
            style_class: 'hc-rule',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            visible: false,
        });
        top.add_child(this._readout);
        top.add_child(this._rule);

        /* The glyph says which part. The caption beside it shows only to say
         * that the level is an old one. */
        const caption = new St.BoxLayout({
            style_class: 'hc-readout-caption',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({
            style_class: 'hc-readout-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._caption = new St.Label({
            style_class: 'hc-readout-label',
            text: _('Last seen'),
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        caption.add_child(this._icon);
        caption.add_child(this._caption);

        const valueRow = new St.BoxLayout({
            style_class: 'hc-readout-value-row',
            x_align: Clutter.ActorAlign.CENTER,
        });
        /* The number and its % sign are two labels, both on the bottom edge so
         * their baselines meet. Markup would draw them in one label, but a
         * label whose markup is replaced keeps an outdated width, which left a
         * gap after a right-aligned number. */
        this._value = new St.Label({
            style_class: 'hc-readout-value',
            y_align: Clutter.ActorAlign.END,
        });
        this._unit = new St.Label({
            style_class: 'hc-readout-unit',
            /* Translators: the sign after a battery level shown large. */
            text: _('%'),
            y_align: Clutter.ActorAlign.END,
            opacity: 215,
        });
        valueRow.add_child(this._value);
        valueRow.add_child(this._unit);

        this._readout.add_child(caption);
        this._readout.add_child(valueRow);

        this._bar = new LevelBar(barSpan);

        this.add_child(top);
        this.add_child(this._bar);
    }

    setDivided(divided) {
        this._rule.visible = divided;
    }

    /* `deviceIcon` is for the 'device' part, which has no glyph of its own. */
    update({part, level, charging, stale}, deviceIcon) {
        if (PART_ICONS[part]) {
            if (part !== this._part)
                this._icon.gicon = bundledIcon(PART_ICONS[part]);
        } else {
            this._icon.icon_name = deviceIcon;
        }
        this._part = part;

        const known = level !== null;
        this._caption.visible = stale;
        /* The number carries the reading; its % sign steps back. */
        this._value.text = known ? `${level}` : '—';
        this._unit.visible = known;

        this._bar.setLevel(known ? level / 100 : 0, {
            charging,
            low: known && !charging && level <= LOW_BATTERY,
        });
        /* The rule stays as it is: it parts this column from the last. */
        this._readout.opacity = this._bar.opacity = known && !stale ? 255 : DIM_OPACITY;

        let reading = known ? percent(level) : _('unknown');
        if (charging)
            reading = _('%s, charging').format(reading);
        else if (stale)
            reading = _('%s when last seen').format(reading);
        this.accessible_name = `${partLabel(part)}: ${reading}`;
    }
});

/* The meter: left bud, case and right bud in three columns of one width, or
 * one column for headphones with a single level, each over its own bar.
 * A plain box rather than a menu item: a menu item that cannot be activated
 * is drawn insensitive, greyed out. */
const BatteryItem = GObject.registerClass(
class BatteryItem extends St.BoxLayout {
    _init() {
        super._init({style_class: 'hc-battery-item', x_expand: true});
        this.layout_manager.homogeneous = true;

        /* In the order they stand, left to right. */
        this._columns = new Map([
            ['left', new PartColumn(BAR_SPAN)],
            ['case', new PartColumn(CASE_BAR_SPAN)],
            ['right', new PartColumn(BAR_SPAN)],
            ['device', new PartColumn(BAR_SPAN)],
        ]);
        for (const column of this._columns.values())
            this.add_child(column);
    }

    update(batteries, deviceIcon) {
        const byPart = Object.fromEntries(batteries.map(b => [b.part, b]));

        /* A rule before each column shown but the first. */
        let divided = false;
        for (const [part, column] of this._columns) {
            const battery = byPart[part];
            column.visible = !!battery;
            if (!battery)
                continue;
            column.update(battery, deviceIcon);
            column.setDivided(divided);
            divided = true;
        }

        this.visible = batteries.length > 0;
    }
});

/* Options in one track; the picked one sits on an accent pill that slides
 * over when the pick changes. Says what the user picked; the device decides
 * what is shown, through select(). */
const ToggleGroup = GObject.registerClass({
    Properties: {
        /* How far the pill has slid from where it was toward the pick, eased
         * from 0 to 1. Width too, as options need not be the same width. */
        'slide': GObject.ParamSpec.double('slide', null, null,
            GObject.ParamFlags.READWRITE, 0, 1, 1),
    },
    Signals: {
        'activated': {param_types: [GObject.TYPE_STRING]},
    },
}, class ToggleGroup extends St.Widget {
    /* `homogeneous`: options share the width equally; otherwise each gets
     * its label's width plus an equal share of what is left, which keeps a
     * long label on one line. */
    _init(styleClass, homogeneous) {
        super._init({
            style_class: `hc-toggle-group ${styleClass}`,
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });

        this._highlight = new St.Widget({
            style_class: 'hc-toggle-highlight',
            visible: false,
        });
        this.add_child(this._highlight);

        this._row = new St.BoxLayout({style_class: 'hc-toggle-row', x_expand: true});
        this._row.layout_manager.homogeneous = homogeneous;
        this.add_child(this._row);

        this._buttons = new Map();
        this._selected = null;
        this._slide = 1;
        /* Where the pill was when the pick changed, and where it is now. */
        this._slideFrom = null;
        this._pill = null;
    }

    get slide() {
        return this._slide;
    }

    set slide(value) {
        if (value === this._slide)
            return;
        this._slide = value;
        this.notify('slide');
        this.queue_relayout();
    }

    /* [{id, label, gicon}], gicon optional. Rebuilt only when the ids change. */
    setOptions(options) {
        if ([...this._buttons.keys()].join() === options.map(o => o.id).join())
            return;

        this._row.destroy_all_children();
        this._buttons.clear();
        this._selected = null;
        this._slideFrom = null;
        this._pill = null;
        this._highlight.hide();
        /* Four options or more: tighter sides, so they still fit. */
        setClass(this, 'hc-crowded', options.length > 3);

        for (const {id, label, gicon} of options) {
            const button = this._button(label, gicon);
            button.connect('clicked', () => this.emit('activated', id));
            this._buttons.set(id, button);
            this._row.add_child(button);
        }
    }

    select(id) {
        const button = this._buttons.get(id) ?? null;
        id = button ? id : null;
        if (id === this._selected)
            return;

        /* From wherever the pill is, mid-slide included. */
        if (this._selected !== null && button && this._pill && this.mapped) {
            this._slideFrom = this._pill.copy();
            this.remove_transition('slide');
            this.slide = 0;
            this.ease_property('slide', 1, {
                duration: SLIDE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }

        this._selected = id;
        for (const [buttonId, b] of this._buttons)
            b.checked = buttonId === id;
        this._highlight.visible = !!button;
        this.queue_relayout();
    }

    _button(label, gicon) {
        /* From the top, so the icons stay in a row when a label wraps. */
        const content = new St.BoxLayout({
            style_class: 'hc-toggle-content',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        if (gicon) {
            content.add_child(new St.Icon({
                style_class: 'hc-toggle-icon',
                gicon,
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }
        /* A one-word label never wraps, so it always gets its full width; a
         * longer one may wrap between words when the track is crowded. */
        const text = new St.Label({
            style_class: 'hc-toggle-label',
            text: label,
            x_align: Clutter.ActorAlign.CENTER,
        });
        text.clutter_text.set({
            line_wrap: /\s/.test(label.trim()),
            line_wrap_mode: Pango.WrapMode.WORD,
            ellipsize: Pango.EllipsizeMode.NONE,
            line_alignment: Pango.Alignment.CENTER,
        });
        content.add_child(text);

        return new St.Button({
            style_class: 'hc-toggle',
            child: content,
            can_focus: true,
            x_expand: true,
            accessible_name: label,
        });
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);

        const button = this._buttons.get(this._selected);
        if (!button) {
            this._pill = null;
            return;
        }

        /* Over the picked button, which the row has just placed. */
        const row = this._row.get_allocation_box();
        const at = button.get_allocation_box();
        const target = [row.x1 + at.x1, row.y1 + at.y1, row.x1 + at.x2, row.y1 + at.y2];

        let [x1, y1, x2, y2] = target;
        const from = this._slideFrom;
        if (from && this._slide < 1) {
            const t = this._slide;
            const mix = (a, b) => a + (b - a) * t;
            [x1, y1, x2, y2] = [mix(from.x1, x1), mix(from.y1, y1),
                mix(from.x2, x2), mix(from.y2, y2)];
        } else {
            this._slideFrom = null;
        }

        this._pill = new Clutter.ActorBox({x1, y1, x2, y2});
        this._highlight.allocate(this._pill);
    }
});

/* The noise control modes, and under noise cancelling, its levels. A plain
 * box for the same reason as the meter. */
const NoiseItem = GObject.registerClass({
    Signals: {
        'mode-activated': {param_types: [GObject.TYPE_STRING]},
        'level-activated': {param_types: [GObject.TYPE_STRING]},
    },
}, class NoiseItem extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'hc-noise-item',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
        });
        const box = this;

        /* Each mode as wide as its name: "Noise Cancelling" stays one line. */
        this._modes = new ToggleGroup('hc-modes', false);
        this._modes.connectObject('activated',
            (_group, mode) => this.emit('mode-activated', mode), this);
        box.add_child(this._modes);

        this._levels = new ToggleGroup('hc-levels', true);
        this._levels.connectObject('activated',
            (_group, level) => this.emit('level-activated', level), this);
        box.add_child(this._levels);

        /* Why a change did not take, or will not. */
        this._hint = new St.Label({
            style_class: 'hc-noise-hint',
            visible: false,
            opacity: 190,
        });
        this._hint.clutter_text.set({
            line_wrap: true,
            ellipsize: Pango.EllipsizeMode.NONE,
        });
        box.add_child(this._hint);
    }

    _hintText(noise) {
        if (noise.worn === false)
            return _('Wear the earbuds to change noise control');
        if (noise.refused)
            return _('The earbuds kept their mode. Try again.');
        return null;
    }

    update(noise) {
        this.visible = !!noise;
        if (!noise)
            return;

        this._modes.setOptions(noise.modes.map(mode => ({
            id: mode,
            label: modeLabel(mode),
            gicon: bundledIcon(MODE_ICONS[mode]),
        })));
        this._modes.select(noise.mode);

        this._levels.setOptions(noise.levels.map(level => ({
            id: level,
            label: levelLabel(level),
        })));
        this._levels.select(noise.level);
        this._levels.visible = noise.mode === 'nc' && noise.levels.length > 1;

        const hint = this._hintText(noise);
        this._hint.visible = !!hint;
        this._hint.text = hint ?? '';
    }
});

function connectionStatus(device) {
    if (device.self)
        return _('This computer');
    if (device.pending === 'disconnect')
        return _('Disconnecting…');
    if (device.pending === 'connect')
        return _('Connecting…');
    if (device.playing)
        return _('Playing');
    return device.connected ? _('Connected') : _('Not connected');
}

/* The devices the headphones are linked with, for buds that connect to
 * several at once: this computer first, then the others, each with a button
 * to drop it or link it again where the headphones take that. Headphones
 * that cannot be told to show only what is connected. */
const ConnectionsItem = GObject.registerClass({
    Signals: {
        /* Address, and whether to connect (true) or disconnect. */
        'activated': {param_types: [GObject.TYPE_STRING, GObject.TYPE_BOOLEAN]},
    },
}, class ConnectionsItem extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'hc-connections',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
            visible: false,
        });

        this.add_child(new St.Label({
            style_class: 'hc-connections-title',
            text: _('Connections'),
            opacity: 190,
        }));
        this._list = new St.BoxLayout({
            style_class: 'hc-connections-list',
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
        });
        this.add_child(this._list);
        this._key = null;
    }

    update(connections) {
        const devices = connections
            ? connections.devices.filter(d => connections.manageable || d.self || d.connected)
            : [];
        /* Worth a section only when something besides this computer is in it. */
        this.visible = devices.some(d => !d.self);
        if (!this.visible)
            return;

        const key = JSON.stringify([connections.manageable, devices]);
        if (key === this._key)
            return;
        this._key = key;

        this._list.destroy_all_children();
        for (const device of devices)
            this._list.add_child(this._row(device, connections.manageable));
    }

    _row(device, manageable) {
        const row = new St.BoxLayout({style_class: 'hc-connection', x_expand: true});
        row.add_child(new St.Icon({
            style_class: 'hc-connection-icon',
            icon_name: device.self ? 'computer-symbolic' : 'phone-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const text = new St.BoxLayout({
            ...boxOrientation(Clutter.Orientation.VERTICAL),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const name = new St.Label({
            style_class: 'hc-connection-name',
            text: device.name || _('Unknown device'),
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(name);
        text.add_child(new St.Label({
            style_class: 'hc-connection-status',
            text: connectionStatus(device),
            opacity: 170,
        }));
        row.add_child(text);

        if (manageable && !device.self) {
            const connect = !device.connected;
            const button = new St.Button({
                style_class: 'hc-connection-action',
                label: connect ? _('Connect') : _('Disconnect'),
                can_focus: true,
                reactive: !device.pending,
                y_align: Clutter.ActorAlign.CENTER,
                accessible_name: connect
                    ? _('Connect %s').format(device.name)
                    : _('Disconnect %s').format(device.name),
            });
            button.connect('clicked', () => this.emit('activated', device.address, connect));
            row.add_child(button);
        }
        return row;
    }
});

/* As tall as its content up to setMaxHeight(), and scrolling past that. The
 * shell opens a menu to the least height it asks for, which a plain scroll
 * view puts at nothing, so this one asks for a single height. */
const FitScrollView = GObject.registerClass(
class FitScrollView extends St.ScrollView {
    _init(params) {
        super._init({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            /* Drawn over the items' own side padding, so the scrollbar takes
             * no width from them. */
            overlay_scrollbars: true,
            ...params,
        });
        this._maxHeight = -1;
    }

    setMaxHeight(height) {
        if (height === this._maxHeight)
            return;
        this._maxHeight = height;
        this.queue_relayout();
    }

    vfunc_get_preferred_height(forWidth) {
        let [, natural] = super.vfunc_get_preferred_height(forWidth);
        if (this._maxHeight >= 0)
            natural = Math.min(natural, this._maxHeight);
        return [natural, natural];
    }
});

/* The menu's middle. A section, so the menu items in it still belong to the
 * menu, whose box sits in a FitScrollView rather than straight in the menu. */
class ScrollingSection extends PopupMenu.PopupMenuSection {
    constructor() {
        super();
        this.actor = new FitScrollView({style_class: 'hc-scroll', child: this.box});
        this.actor._delegate = this;
    }

    setMaxHeight(height) {
        this.actor.setMaxHeight(height);
    }

    scrollToTop() {
        this.actor.vadjustment.value = 0;
    }

    /* Scrolls `actor`, which has the key focus, into view if it is in here. */
    reveal(actor) {
        if (actor && this.box.contains(actor))
            ensureActorVisibleInScrollView(this.actor, actor);
    }
}

const HeadphoneToggle = GObject.registerClass(
class HeadphoneToggle extends QuickMenuToggle {
    _init(manager) {
        super._init({
            title: _('Headphones'),
            iconName: 'audio-headphones-symbolic',
            toggleMode: false,
            visible: false,
        });

        this._manager = manager;
        this._headphone = null;
        /* The one picked from the list when several are connected. */
        this._selectedPath = null;
        this._devicesKey = null;

        this.menu.setHeader('audio-headphones-symbolic', _('Headphones'));
        this._addSettingsButton();

        /* Everything under the header, which stays in sight above. */
        this._middle = new ScrollingSection();
        this.menu.addMenuItem(this._middle);

        /* Straight into the section's box, in order, ahead of the menu items. */
        this._batteryItem = new BatteryItem();
        this._middle.box.add_child(this._batteryItem);

        this._noiseItem = new NoiseItem();
        this._noiseItem.connectObject(
            'mode-activated', (_item, mode) => this._headphone?.setNoise(mode),
            'level-activated', (_item, level) => this._headphone?.setNoise('nc', level),
            this);
        this._middle.box.add_child(this._noiseItem);

        this._connectionsItem = new ConnectionsItem();
        this._connectionsItem.connectObject('activated',
            (_item, address, connect) => this._headphone?.setConnection(address, connect),
            this);
        this._middle.box.add_child(this._connectionsItem);

        this._devicesSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._middle.addMenuItem(this._devicesSeparator);
        this._devicesSection = new PopupMenu.PopupMenuSection();
        this._middle.addMenuItem(this._devicesSection);

        /* The shell eases the menu open to the height it asks for as it
         * opens, so the middle must know its room just before. */
        const open = this.menu.open.bind(this.menu);
        this.menu.open = animate => {
            this._fitToScreen();
            open(animate);
        };

        /* Keyboard focus moving onto a control scrolled out of sight. */
        global.stage.connectObject('notify::key-focus', () => {
            if (this.menu.isOpen)
                this._middle.reveal(global.stage.key_focus);
        }, this);

        this.connect('clicked', () => this._onClicked());
        this._manager.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    /* The menu lives in the quick settings' overlay, not under the tile,
     * and the shell does not destroy it with the tile. Only the indicator
     * destroys the tile, always through here. */
    destroy() {
        global.stage.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._manager.disconnectObject(this);
        this._manager = null;
        this._headphone = null;

        this._batteryItem.destroy();
        this._batteryItem = null;
        this._noiseItem.destroy();
        this._noiseItem = null;
        this._connectionsItem.destroy();
        this._connectionsItem = null;
        this._devicesSection.destroy();
        this._devicesSection = null;
        this._devicesSeparator.destroy();
        this._devicesSeparator = null;
        this._middle.destroy();
        this._middle = null;
        this.menu.destroy();

        super.destroy();
    }

    /* Bluetooth Settings, as a button in the header's far corner. Shown, as
     * the shell's own settings items are, only where the session allows. */
    _addSettingsButton() {
        const button = new St.Button({
            style_class: 'icon-button flat hc-settings-button',
            child: new St.Icon({icon_name: 'bluetooth-active-symbolic'}),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Bluetooth Settings'),
        });
        button.connect('clicked', () => {
            const app = Shell.AppSystem.get_default().lookup_app(SETTINGS_APP);
            if (!app)
                return;
            Main.overview.hide();
            Main.panel.closeQuickSettings();
            app.activate();
        });

        const sync = () => {
            button.visible = Main.sessionMode.allowSettings;
        };
        Main.sessionMode.connectObject('updated', sync, this);
        sync();

        /* Past the spacer at the header's end, beside the menu's edge, and
         * down both of its rows. The shell's addHeaderSuffix() would put it
         * right after the title; it is the way in if the header changes. */
        const {_header: header, _headerSpacer: spacer} = this.menu;
        if (header?.layout_manager instanceof Clutter.GridLayout &&
            spacer?.get_parent() === header) {
            const side = this.menu.actor.text_direction === Clutter.TextDirection.RTL
                ? Clutter.GridPosition.LEFT : Clutter.GridPosition.RIGHT;
            header.layout_manager.attach_next_to(button, spacer, side, 1, 2);
        } else {
            this.menu.addHeaderSuffix(button);
        }
    }

    /* A tap only opens the menu; noise control is switched from there. */
    _onClicked() {
        this.menu.open();
    }

    /* Opening, the menu pushes the quick settings' bottom edge down by its
     * own height. Lets the middle grow only as far as keeps that edge on
     * screen, as far above the screen's bottom as the quick settings sit
     * below the top bar. Measured with the menu shut, so the quick settings
     * stand without it. */
    _fitToScreen() {
        const quickSettings = Main.panel.statusArea.quickSettings.menu.box;
        if (!quickSettings.mapped)
            return;

        const [, top] = quickSettings.get_transformed_position();
        const [, height] = quickSettings.get_transformed_size();
        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            Main.layoutManager.findIndexForActor(this));
        const margin = Math.max(top - workArea.y, 0);
        const room = workArea.y + workArea.height - margin - (top + height);

        /* Shown, as open() is about to, at the height it has: hidden since it
         * was made or last shut, it has not taken its style, and measures
         * short without its margin and the header's spacing. */
        this.menu.actor.show();

        /* The rest of the menu: header and padding. Both at
         * their natural width, so the middle measures the same in each. */
        const [, menuHeight] = this.menu.box.get_preferred_height(-1);
        const [, middleHeight] = this._middle.actor.get_preferred_height(-1);
        const rest = menuHeight - middleHeight;

        const {scale_factor: scale} = St.ThemeContext.get_for_stage(global.stage);
        this._middle.setMaxHeight(Math.max(room - rest, MIN_SCROLL_HEIGHT * scale));
        this._middle.scrollToTop();
    }

    _sync() {
        const headphones = this._manager.headphones;
        const headphone = headphones.find(h => h.path === this._selectedPath) ??
            headphones[0] ?? null;
        this._headphone = headphone;

        this.visible = !!headphone;
        if (!headphone) {
            this.menu.close();
            return;
        }

        const name = headphone.name || _('Headphones');
        const batteries = headphone.batteries;
        const noise = headphone.noise;
        const summary = noiseSummary(noise);

        this.set({
            title: name,
            subtitle: this._batterySummary(batteries) ?? summary,
            iconName: headphone.iconName,
            /* Lit for noise cancelling; headphones without a switch are lit
             * while connected, as there is nothing to turn off. */
            checked: headphone.canToggleNoise ? headphone.noiseOn : true,
        });
        /* The model, and its maker under it where known. What noise control
         * is doing, the switcher shows. */
        const {brand, model} = headphone.identity;
        this.menu.setHeader(headphone.iconName, model || name, brand ?? '');

        this._batteryItem.update(batteries, headphone.iconName);
        this._noiseItem.update(noise);
        this._connectionsItem.update(headphone.connections);
        this._syncDevices(headphones);
    }

    /* Short enough for the tile: "80 %" for one level or two equal ones,
     * "80 / 75 %" for left and right, null with none known. The case is left
     * to the menu. */
    _batterySummary(batteries) {
        const levels = batteries
            .filter(b => b.part !== 'case' && b.level !== null)
            .map(b => b.level);
        if (levels.length === 0)
            return null;
        if (levels.length === 1 || levels[0] === levels[1])
            return percent(levels[0]);
        /* Translators: the left and right earbuds' battery, as in "80 / 75 %". */
        return _('%d / %d %%').format(levels[0], levels[1]);
    }

    /* A list to pick from, only while more than one is connected. */
    _syncDevices(headphones) {
        const key = [this._headphone.path,
            ...headphones.map(h => `${h.path}\n${h.name}`)].join('\n');
        if (key === this._devicesKey)
            return;
        this._devicesKey = key;

        this._devicesSection.removeAll();
        const several = headphones.length > 1;
        this._devicesSection.actor.visible = several;
        this._devicesSeparator.visible = several;
        if (!several)
            return;

        for (const headphone of headphones) {
            const item = new PopupMenu.PopupImageMenuItem(
                headphone.name || _('Headphones'), headphone.iconName);
            item.setOrnament(headphone === this._headphone
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.connect('activate', () => {
                this._selectedPath = headphone.path;
                this._sync();
            });
            this._devicesSection.addMenuItem(item);
        }
    }
});

/* Holds the tile. It has no panel icon of its own, so nothing shows on the
 * panel. */
export const HeadphoneIndicator = GObject.registerClass(
class HeadphoneIndicator extends SystemIndicator {
    _init(manager) {
        super._init();

        this.quickSettingsItems.push(new HeadphoneToggle(manager));

        /* Not every model pushes every change: read the buds again whenever
         * the quick settings open. */
        Main.panel.statusArea.quickSettings.menu.connectObject(
            'open-state-changed', (_menu, open) => {
                if (open)
                    manager.refresh();
            }, this);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems = [];
        super.destroy();
    }
});
