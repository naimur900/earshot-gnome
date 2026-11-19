// SPDX-License-Identifier: GPL-3.0-or-later
/* headphones.js: the Bluetooth headphones that are connected. Each shows what
 * BlueZ knows; headphones of a brand with a backend (backends/index.js) also
 * get a control channel for the battery of each bud and the case, and for
 * noise control. What the headphones do not report is not shown. */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {findBackend} from './backends/index.js';
import {BluezClient} from './bluez.js';
import {identify} from './brands.js';
import {isCancelling} from './noise.js';
import {VendorProfile} from './profile.js';

/* BlueZ's icons for the headphone classes of device. */
const HEADPHONE_ICONS = ['audio-headset', 'audio-headphones'];

const HANDSFREE_UUID = '0000111e-0000-1000-8000-00805f9b34fb';
const HEADSET_UUID = '00001108-0000-1000-8000-00805f9b34fb';

const DEVICE_IFACE = 'org.bluez.Device1';
const PROFILE_PATH = '/org/gnome/shell/extensions/Earshot';

/* Seconds before each try at the control channel. The first gives the audio
 * profiles time to settle after the headphones connect; after the last,
 * opening the quick settings tries again. */
const CONNECT_DELAYS = [2, 5, 15, 45];

const BATTERY_PARTS = ['left', 'right', 'case'];

/* Whether to show a device. Many budget earbuds call themselves speakers or
 * nothing at all; a headset profile and a battery level give them away. */
function isHeadphone(info) {
    if (!info?.connected)
        return false;
    if (HEADPHONE_ICONS.includes(info.icon) || findBackend(info))
        return true;
    const headset = info.uuids.includes(HANDSFREE_UUID) || info.uuids.includes(HEADSET_UUID);
    return headset && info.battery !== null && (info.icon === '' || info.icon.startsWith('audio'));
}

class Headphone {
    /* `memory` outlives the connection: {caseLevel}. */
    constructor(manager, info, memory) {
        this._manager = manager;
        this._info = info;
        this._match = findBackend(info);
        this._memory = memory;
        this.path = info.path;
        this.connectedAt = GLib.get_monotonic_time();

        this._session = null;
        this._attempt = 0;
        this._connectId = 0;
        this._connecting = false;
        this._destroyed = false;

        this._scheduleConnect();
    }

    get name() {
        return this._info.alias || this._info.name;
    }

    /* {brand, model}: the maker, or null, and the name without it. */
    get identity() {
        const {name, alias} = this._info;
        return identify({name, alias, backend: this._match?.backend.id ?? null});
    }

    get iconName() {
        const icon = HEADPHONE_ICONS.includes(this._info.icon)
            ? this._info.icon : 'audio-headphones';
        return `${icon}-symbolic`;
    }

    /* [{part, level, charging, stale}]: 'left', 'right' and 'case' from the
     * headphones' own report, else one 'device' level, theirs or BlueZ's. A
     * case with no level is left out; a `stale` level is the case's from
     * earlier, kept while the shut case reports none. A bud with no level
     * keeps its place, as the other one's partner, with `level` null. */
    get batteries() {
        const report = this._session?.battery ?? {};
        const parts = [];

        for (const part of BATTERY_PARTS) {
            if (!(part in report))
                continue;
            const info = report[part];
            if (info)
                parts.push({part, level: info.level, charging: info.charging, stale: false});
            else if (part === 'case' && this._memory.caseLevel !== undefined)
                parts.push({part, level: this._memory.caseLevel, charging: false, stale: true});
            else if (part !== 'case')
                parts.push({part, level: null, charging: false, stale: false});
        }

        /* Buds that both say nothing are no better than one level. */
        if (parts.some(p => p.part !== 'case' && p.level !== null))
            return parts;

        const device = report.device ??
            (this._info.battery !== null ? {level: this._info.battery, charging: false} : null);
        if (device)
            return [{part: 'device', level: device.level, charging: device.charging, stale: false}];
        return parts.filter(p => p.part === 'case');
    }

    /* {modes, levels, mode, level, worn, refused}, or null when the
     * headphones have no noise control, or have not said what they have. */
    get noise() {
        const session = this._session;
        if (!session || session.noiseModes.length === 0)
            return null;
        return {
            modes: session.noiseModes,
            levels: session.noiseLevels,
            mode: session.noise?.mode ?? null,
            level: session.noise?.level ?? null,
            worn: session.wear ? session.wear.left || session.wear.right : null,
            refused: session.refused,
        };
    }

    /* Whether the tile shows noise control on: a cancelling mode, or, on
     * headphones that only let sound in, transparency. */
    get noiseOn() {
        const noise = this.noise;
        if (!noise)
            return false;
        if (noise.modes.some(isCancelling))
            return isCancelling(noise.mode);
        return noise.mode === 'transparency';
    }

    /* Whether noise control has an on and an off to light the tile by. */
    get canToggleNoise() {
        const modes = this.noise?.modes ?? [];
        return (modes.some(isCancelling) && modes.some(m => !isCancelling(m))) ||
            (modes.includes('off') && modes.includes('transparency'));
    }

    setNoise(mode, level = null) {
        this._session?.setNoise(mode, level);
    }

    /* {devices, manageable}: the devices the headphones are linked with (see
     * session.js), this computer first, and whether they can be connected and
     * disconnected from here; or null when the headphones keep no list. */
    get connections() {
        const devices = this._session?.devices;
        if (!devices)
            return null;
        return {
            devices: [...devices].sort((a, b) => b.self - a.self),
            manageable: this._session.canManageDevices,
        };
    }

    setConnection(address, connect) {
        if (connect)
            this._session?.connectDevice(address);
        else
            this._session?.disconnectDevice(address);
    }

    /* Reads everything again, or tries the control channel again. */
    refresh() {
        if (this._session) {
            this._session.refresh();
        } else if (this._match && !this._connecting) {
            this._attempt = 0;
            this._clearConnect();
            this._connect();
        }
    }

    /* True when something shown changed. */
    update(info) {
        const before = this._key();
        this._info = info;
        /* A device's services can arrive after it connects. */
        if (!this._session)
            this._match = findBackend(info);
        if (!this._session)
            this._scheduleConnect();
        return this._key() !== before;
    }

    _key() {
        const {alias, name, icon, battery} = this._info;
        return JSON.stringify([alias, name, icon, battery, this._match?.uuid]);
    }

    /* Takes a control channel BlueZ opened. False if it is not usable. */
    attach(fd) {
        if (!this._match)
            return false;

        let session;
        try {
            session = new this._match.backend.Session(fd, this._info);
        } catch (e) {
            console.warn(`Earshot: unusable control channel: ${e.message}`);
            return false;
        }

        this.detach();
        this._clearConnect();
        this._session = session;
        session.connect('changed', () => this._onSessionChanged());
        session.connect('closed', () => {
            if (this._session !== session)
                return;
            this._session = null;
            this._manager.notifyChanged();
            this._scheduleConnect();
        });
        session.start();
        return true;
    }

    detach() {
        if (!this._session)
            return;
        const session = this._session;
        this._session = null;
        session.destroy();
        this._manager.notifyChanged();
    }

    _onSessionChanged() {
        const session = this._session;
        if (!session)
            return;
        const caseInfo = session.battery.case;
        if (caseInfo)
            this._memory.caseLevel = caseInfo.level;

        /* A channel that answers resets the tries. */
        this._attempt = 0;
        this._manager.notifyChanged();
    }

    _scheduleConnect() {
        if (this._destroyed || this._session || this._connectId || this._connecting ||
            !this._match || this._attempt >= CONNECT_DELAYS.length)
            return;

        const delay = CONNECT_DELAYS[this._attempt++];
        this._connectId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._connectId = 0;
            this._connect();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _connect() {
        if (this._session || this._connecting || !this._match)
            return;

        this._connecting = true;
        try {
            await this._manager.connectProfile(this.path, this._match);
        } catch (e) {
            if (!this._destroyed)
                console.debug(`Earshot: no control channel yet: ${e.message}`);
        }
        this._connecting = false;

        /* Connected, the channel arrives through attach(), usually before the
         * call returns. */
        if (!this._destroyed && !this._session)
            this._scheduleConnect();
    }

    _clearConnect() {
        if (this._connectId) {
            GLib.source_remove(this._connectId);
            this._connectId = 0;
        }
    }

    destroy() {
        this._destroyed = true;
        this._clearConnect();
        if (this._session) {
            this._session.destroy();
            this._session = null;
        }
    }
}

export const HeadphoneManager = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class HeadphoneManager extends GObject.Object {
    _init() {
        super._init();

        this._headphones = new Map();
        /* Per device path, for as long as the extension runs. */
        this._memory = new Map();
        /* Per service UUID, registered when a brand's headphones first need
         * it. */
        this._profiles = new Map();

        this._bluez = new BluezClient();
        this._bluez.connectObject(
            'device-changed', (_bluez, path) => this._syncDevice(path),
            'service-changed', () => this._syncAll(),
            this);
    }

    /* The connected headphones, the latest to connect first. */
    get headphones() {
        return [...this._headphones.values()]
            .sort((a, b) => b.connectedAt - a.connectedAt);
    }

    refresh() {
        for (const headphone of this._headphones.values())
            headphone.refresh();
    }

    async connectProfile(path, {backend, uuid}) {
        await this._profile(backend, uuid).register();
        await this._bluez.call(path, DEVICE_IFACE, 'ConnectProfile',
            new GLib.Variant('(s)', [uuid]));
    }

    notifyChanged() {
        this.emit('changed');
    }

    _profile(backend, uuid) {
        let profile = this._profiles.get(uuid);
        if (!profile) {
            const path = `${PROFILE_PATH}/${backend.id}_${uuid.slice(0, 8)}`;
            profile = new VendorProfile(this._bluez, path, uuid, 'Earshot', {
                onConnection: (device, fd) =>
                    this._headphones.get(device)?.attach(fd) ?? false,
                onDisconnection: device => this._headphones.get(device)?.detach(),
            });
            this._profiles.set(uuid, profile);
        }
        return profile;
    }

    /* bluetoothd started or stopped: every device may be new or gone. */
    _syncAll() {
        if (!this._bluez.available) {
            for (const profile of this._profiles.values())
                profile.forget();
        }

        const paths = new Set([...this._headphones.keys(), ...this._bluez.devicePaths]);
        for (const path of paths)
            this._syncDevice(path);
    }

    _syncDevice(path) {
        const info = this._bluez.getDevice(path);
        const headphone = this._headphones.get(path);

        if (!isHeadphone(info)) {
            if (headphone) {
                headphone.destroy();
                this._headphones.delete(path);
                this.emit('changed');
            }
            return;
        }

        if (headphone) {
            if (headphone.update(info))
                this.emit('changed');
            return;
        }

        if (!this._memory.has(path))
            this._memory.set(path, {});
        this._headphones.set(path, new Headphone(this, info, this._memory.get(path)));
        this.emit('changed');
    }

    destroy() {
        this._bluez.disconnectObject(this);
        for (const headphone of this._headphones.values())
            headphone.destroy();
        this._headphones.clear();
        for (const profile of this._profiles.values())
            profile.destroy();
        this._profiles.clear();
        this._bluez.destroy();
    }
});
