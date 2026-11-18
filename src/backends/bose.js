// SPDX-License-Identifier: GPL-3.0-or-later
/* backends/bose.js: Bose headphones and earbuds, BMAP, the protocol of the
 * Bose app. Battery of the headphones, or of each bud and the case, and noise
 * control: the Quiet and Aware modes (and Immersion and Cinema on the Ultra
 * models) of current Bose, or off, low and high noise cancelling, and wind,
 * on the QuietComfort 35.
 *
 * A packet is `<function block> <function> <operator> <length> <payload>`;
 * replies use the same address, with operator 3 (status), 4 (error) or 6
 * (result). Follows bosectl's reverse engineering. */

import GObject from 'gi://GObject';

import {ChannelSession} from '../session.js';

const BMAP_UUID = '00000000-deca-fade-deca-deafdecacaff';

const OP_GET = 1;
const OP_SETGET = 2;
const OP_STATUS = 3;
const OP_ERROR = 4;
const OP_START = 5;

const PRODUCT_INFO = [0, 1];
const BATTERY = [2, 2];
const ANR = [1, 6];
const CURRENT_MODE = [31, 3];

/* Battery record components. */
const COMPONENTS = {0: 'device', 1: 'right', 2: 'left', 3: 'case', 4: 'buds'};

/* AudioModes preset indexes; the Ultra models add the two spatial ones. */
const PRESETS = {0: 'nc', 1: 'transparency', 2: 'immersion', 3: 'cinema'};
const PRESET_INDEXES = {nc: 0, transparency: 1, immersion: 2, cinema: 3};
const ULTRA_PRODUCTS = new Set([0x4066, 0x4082, 0x4083, 0x4062, 0x4072]);

/* QC35 ANR values: off, high, wind, low. High and low are noise
 * cancelling's levels. */
const ANR_STATES = {0: {mode: 'off', level: null}, 1: {mode: 'nc', level: 'deep'},
    2: {mode: 'wind', level: null}, 3: {mode: 'nc', level: 'light'}};

export function bmapPacket([fblock, func], operator, payload = []) {
    return new Uint8Array([fblock, func, operator & 0x0f, payload.length, ...payload]);
}

/* [[{fblock, func, op, payload}], rest]. */
export function parseBmap(buffer) {
    const packets = [];
    let pos = 0;
    while (pos + 4 <= buffer.length) {
        const length = buffer[pos + 3];
        if (pos + 4 + length > buffer.length)
            break;
        packets.push({
            fblock: buffer[pos],
            func: buffer[pos + 1],
            op: buffer[pos + 2] & 0x0f,
            payload: buffer.slice(pos + 4, pos + 4 + length),
        });
        pos += 4 + length;
    }
    return [packets, buffer.slice(pos)];
}

/* {left, right, case, device} from a battery status: four-byte records of
 * `<level> FF FF <component>`, or one level byte on older models. */
export function parseBoseBattery(payload) {
    const read = value => value <= 100 ? {level: value, charging: false} : null;
    if (payload.length < 4 || payload.length % 4 !== 0)
        return payload.length > 0 ? {device: read(payload[0])} : null;

    const parts = {};
    for (let i = 0; i + 3 < payload.length; i += 4) {
        const part = COMPONENTS[payload[i + 3]];
        if (part)
            parts[part] = read(payload[i]);
    }
    /* "buds" is the two together; it stands in only when they are not given. */
    if (parts.buds !== undefined) {
        if (parts.left === undefined && parts.right === undefined)
            parts.device = parts.buds;
        delete parts.buds;
    }
    return parts;
}

const BoseSession = GObject.registerClass(
class BoseSession extends ChannelSession {
    _init(fd, info) {
        super._init(fd, info);
        /* Modes by preset, or by ANR on the QC35; null until one answers. */
        this._scheme = null;
    }

    _start() {
        this._packet(PRODUCT_INFO, OP_GET);
        this._packet(BATTERY, OP_GET);
        this._packet(CURRENT_MODE, OP_GET);
    }

    refresh() {
        this._packet(BATTERY, OP_GET);
        this._packet(this._scheme === 'anr' ? ANR : CURRENT_MODE, OP_GET);
    }

    setNoise(mode, level = null) {
        if (!this.noiseModes.includes(mode))
            return;
        if (this._scheme === 'anr') {
            const value = mode === 'off' ? 0 : mode === 'wind' ? 2 : level === 'light' ? 3 : 1;
            this._packet(ANR, OP_SETGET, [value]);
            this._expectNoise(ANR_STATES[value], () => this._packet(ANR, OP_GET));
        } else {
            this._packet(CURRENT_MODE, OP_START, [PRESET_INDEXES[mode], 0]);
            this._expectNoise({mode, level: null}, () => this._packet(CURRENT_MODE, OP_GET));
        }
    }

    _packet(address, operator, payload) {
        this._send(bmapPacket(address, operator, payload));
    }

    _parse(buffer) {
        const [packets, rest] = parseBmap(buffer);
        for (const packet of packets)
            this._handle(packet);
        return rest;
    }

    _handle({fblock, func, op, payload}) {
        const is = ([b, f]) => fblock === b && func === f;

        if (is(BATTERY) && op === OP_STATUS) {
            const parts = parseBoseBattery(payload);
            if (parts) {
                this.battery = {...this.battery, ...parts};
                this._changed();
            }
        } else if (is(CURRENT_MODE)) {
            if (op === OP_ERROR && !this._scheme) {
                /* No AudioModes block: a QC35, with noise cancelling levels. */
                this._packet(ANR, OP_GET);
            } else if (op === OP_STATUS && payload.length > 0) {
                this._scheme = 'presets';
                const ultra = ULTRA_PRODUCTS.has(this.info.product);
                this.noiseModes = ultra
                    ? ['transparency', 'nc', 'immersion', 'cinema']
                    : ['transparency', 'nc'];
                this._setNoise({mode: PRESETS[payload[0]] ?? null, level: null});
            }
        } else if (is(ANR) && op === OP_STATUS && payload.length > 0) {
            this._scheme = 'anr';
            this.noiseModes = ['off', 'nc', ...payload[0] === 2 ? ['wind'] : []];
            this.noiseLevels = ['light', 'deep'];
            this._setNoise(ANR_STATES[payload[0]] ?? null);
        }
    }

    _setNoise(state) {
        this._noiseConfirmed();
        /* A custom mode of the user's own is none of the presets. */
        this.noise = state?.mode ? state : null;
        if (state?.mode === 'wind' && !this.noiseModes.includes('wind'))
            this.noiseModes = [...this.noiseModes, 'wind'];
        this._changed();
    }
});

export default {
    id: 'bose',
    match: info => info.uuids.includes(BMAP_UUID) ? BMAP_UUID : null,
    Session: BoseSession,
};
