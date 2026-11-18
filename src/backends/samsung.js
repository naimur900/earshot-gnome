// SPDX-License-Identifier: GPL-3.0-or-later
/* backends/samsung.js: Samsung Galaxy Buds, the protocol of the Galaxy
 * Wearable app. Battery of each bud and the case, and noise control: ambient
 * sound on the first Buds and Buds+, noise cancelling on the Buds Live, and
 * off, ambient and noise cancelling on the Buds Pro and everything after.
 *
 * A frame is `<SOM> <header> <id> <payload> <CRC-16/XMODEM LE> <EOM>`, the CRC
 * over the id and payload. The first Buds use FE…EE and a header of type then
 * size; the rest FD…DD and a 16-bit little-endian header whose low 10 bits
 * are the size (id, payload and CRC). The buds send their whole state on
 * connecting and after each change; nothing asks for it. Follows
 * GalaxyBudsClient's and Gadgetbridge's reverse engineering. */

import GObject from 'gi://GObject';

import {ChannelSession, level} from '../session.js';

const UUID_LEGACY = '00001102-0000-1000-8000-00805f9b34fd';
const UUID_STANDARD = '00001101-0000-1000-8000-00805f9b34fb';
const UUID_NEW = '2e73a4ad-332d-41fc-90e2-16bef06523f2';

/* Samsung's Bluetooth company id. */
const SAMSUNG = 0x0075;

const MSG_STATUS = 0x60;
const MSG_EXTENDED_STATUS = 0x61;
const MSG_NOISE_CONTROLS_UPDATE = 0x77;
const MSG_NOISE_CONTROLS = 0x78;
const MSG_SET_AMBIENT = 0x80;
const MSG_AMBIENT_UPDATE = 0x81;
const MSG_MANAGER_INFO = 0x88;
const MSG_SET_NOISE_REDUCTION = 0x98;
const MSG_NOISE_REDUCTION_UPDATE = 0x9b;

/* NOISE_CONTROLS values. */
const NOISE_VALUES = {off: 0, nc: 1, transparency: 2, adaptive: 3};
const NOISE_NAMES = {0: 'off', 1: 'nc', 2: 'transparency', 3: 'adaptive'};

export function crc16xmodem(bytes) {
    let crc = 0;
    for (const byte of bytes) {
        crc ^= byte << 8;
        for (let bit = 0; bit < 8; bit++)
            crc = crc & 0x8000 ? (crc << 1 ^ 0x1021) & 0xffff : crc << 1 & 0xffff;
    }
    return crc;
}

export function encodeGalaxy(legacy, id, payload = []) {
    const size = 1 + payload.length + 2;
    const crc = crc16xmodem([id, ...payload]);
    const header = legacy ? [0xfe, 0x00, size] : [0xfd, size & 0xff, size >> 8 & 0x03];
    return new Uint8Array([...header, id, ...payload, crc & 0xff, crc >> 8, legacy ? 0xee : 0xdd]);
}

/* [[{id, payload}], rest]. Frames with a bad CRC are dropped. */
export function parseGalaxy(legacy, buffer) {
    const som = legacy ? 0xfe : 0xfd;
    const eom = legacy ? 0xee : 0xdd;
    const messages = [];
    let pos = 0;

    while (pos < buffer.length) {
        if (buffer[pos] !== som) {
            pos++;
            continue;
        }
        if (pos + 3 > buffer.length)
            break;
        const size = legacy ? buffer[pos + 2] : (buffer[pos + 1] | buffer[pos + 2] << 8) & 0x3ff;
        const end = pos + 3 + size + 1;
        if (size < 3) {
            pos++;
            continue;
        }
        if (end > buffer.length)
            break;
        if (buffer[end - 1] !== eom) {
            pos++;
            continue;
        }

        const id = buffer[pos + 3];
        const payload = buffer.slice(pos + 4, pos + 3 + size - 2);
        const crc = buffer[pos + 3 + size - 2] | buffer[pos + 3 + size - 1] << 8;
        if (crc16xmodem([id, ...payload]) === crc)
            messages.push({id, payload});
        pos = end;
    }

    return [messages, buffer.slice(pos)];
}

/* The model family from the name the buds go by and the services they
 * offer: 'legacy' (Galaxy Buds), 'plus', 'live', or 'modern' (Buds Pro and
 * every model after it). */
function family(info) {
    if (info.uuids.includes(UUID_LEGACY))
        return 'legacy';
    if (info.uuids.includes(UUID_NEW))
        return 'modern';
    const name = info.name;
    if (name.includes('Buds+'))
        return 'plus';
    if (name.includes('Buds Live'))
        return 'live';
    return 'modern';
}

const GalaxySession = GObject.registerClass(
class GalaxySession extends ChannelSession {
    _init(fd, info) {
        super._init(fd, info);
        this._family = family(info);
        this._legacy = this._family === 'legacy';
        this._greeted = false;

        this.noiseModes = {
            legacy: ['off', 'transparency'],
            plus: ['off', 'transparency'],
            live: ['off', 'nc'],
            modern: ['off', 'transparency', 'nc'],
        }[this._family];
    }

    setNoise(mode) {
        if (!this.noiseModes.includes(mode))
            return;
        if (this._family === 'legacy' || this._family === 'plus')
            this._message(MSG_SET_AMBIENT, [mode === 'transparency' ? 1 : 0]);
        else if (this._family === 'live')
            this._message(MSG_SET_NOISE_REDUCTION, [mode === 'nc' ? 1 : 0]);
        else
            this._message(MSG_NOISE_CONTROLS, [NOISE_VALUES[mode]]);
        /* The buds report the change; there is nothing to read it back with. */
        this._expectNoise({mode, level: null}, () => {});
    }

    _message(id, payload) {
        this._send(encodeGalaxy(this._legacy, id, payload));
    }

    _parse(buffer) {
        const [messages, rest] = parseGalaxy(this._legacy, buffer);
        for (const message of messages)
            this._handle(message);
        return rest;
    }

    _handle({id, payload}) {
        switch (id) {
        case MSG_STATUS:
            this._onStatus(payload);
            break;
        case MSG_EXTENDED_STATUS:
            this._onExtendedStatus(payload);
            /* The app answers the first full state with who it is. */
            if (!this._greeted) {
                this._greeted = true;
                this._message(MSG_MANAGER_INFO, [1, 1, 34]);
            }
            break;
        case MSG_NOISE_CONTROLS_UPDATE:
            this._setMode(NOISE_NAMES[payload[0]]);
            break;
        case MSG_AMBIENT_UPDATE:
            this._setMode(payload[0] === 1 ? 'transparency' : 'off');
            break;
        case MSG_NOISE_REDUCTION_UPDATE:
            this._setMode(payload[0] === 1 ? 'nc' : 'off');
            break;
        }
    }

    _onStatus(p) {
        if (this._legacy) {
            if (p.length < 3)
                return;
            this._setBattery({left: level(p[1]), right: level(p[2])});
            return;
        }
        if (p.length < 7)
            return;
        /* Charging bits, where the model sends them: 4 left, 2 right, 0 case. */
        const bits = this._family === 'modern' && p.length > 7 ? p[7] : 0;
        this._setBattery({
            left: level(p[1], {charging: !!(bits & 0x10)}),
            right: level(p[2], {charging: !!(bits & 0x04)}),
            case: level(p[6], {charging: !!(bits & 0x01)}),
        });
    }

    _onExtendedStatus(p) {
        if (this._legacy) {
            if (p.length < 8)
                return;
            this._setBattery({left: level(p[2]), right: level(p[3])});
            this._setMode(p[7] ? 'transparency' : 'off');
            return;
        }
        if (p.length < 8)
            return;
        this._setBattery({left: level(p[2]), right: level(p[3]), case: level(p[7])});

        if (this._family === 'plus' && p.length > 8)
            this._setMode(p[8] ? 'transparency' : 'off');
        else if (this._family === 'live' && p.length > 12)
            this._setMode(p[12] ? 'nc' : 'off');
        else if (this._family === 'modern' && p.length > 12)
            this._setMode(NOISE_NAMES[p[12]]);
    }

    /* A charging bud keeps its last level when the report has none. */
    _setBattery(parts) {
        this.battery = {...this.battery, ...parts};
        this._changed();
    }

    _setMode(mode) {
        if (!mode)
            return;
        /* Adaptive shows up only on the models that report it. */
        if (!this.noiseModes.includes(mode))
            this.noiseModes = [...this.noiseModes, mode];
        this.noise = {mode, level: null};
        this._noiseConfirmed();
        this._changed();
    }
});

export default {
    id: 'samsung',
    match(info) {
        if (info.uuids.includes(UUID_NEW))
            return UUID_NEW;
        if (info.uuids.includes(UUID_LEGACY))
            return UUID_LEGACY;
        const samsung = info.vendor === SAMSUNG || /Galaxy Buds|Buds Live|Buds Pro|Buds\+/.test(info.name);
        if (samsung && info.uuids.includes(UUID_STANDARD))
            return UUID_STANDARD;
        return null;
    },
    Session: GalaxySession,
};
