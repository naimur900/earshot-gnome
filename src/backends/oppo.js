// SPDX-License-Identifier: GPL-3.0-or-later
/* backends/oppo.js: OPPO, OnePlus and realme earbuds, the protocol their
 * HeyMelody and realme Link apps speak over a serial port channel. Battery of
 * each bud and the case, wear, and noise control with per-model levels.
 *
 * A frame is `AA <len> 00 00 <cmd LE16> <seq> <payload length LE16> <payload>`,
 * `len` counting from the first 00 and written 7 bits a byte, low first. A
 * reply's command is the request's with the top bit set, and its payload
 * starts with a status byte, 00 for success. Follows Gadgetbridge's and
 * QuickBuds' reverse engineering; tested on a realme Buds T500 Pro. */

import GObject from 'gi://GObject';

import {NOISE_LEVELS} from '../noise.js';
import {ChannelSession} from '../session.js';
import {MODELS} from './oppoModels.js';

/* The vendor's serial port service: OPPO's Bluetooth company id, 0x079A, in
 * the base UUID its chip vendor uses for control channels. */
export const OPPO_UUID = '0000079a-d102-11e1-9b23-00025b00a5a5';

const CMD_HANDSHAKE = 0x0100;
const CMD_PRODUCT_ID = 0x0103;
const CMD_QUERY_BATTERY = 0x0106;
const CMD_QUERY_WEAR = 0x0109;
const CMD_QUERY_NOISE = 0x010c;
const CMD_QUERY_DEVICES = 0x0112;
const CMD_QUERY_EVENTS = 0x0200;
const CMD_PUSH = 0x0204;
const CMD_SUBSCRIBE = 0x0205;
const CMD_SET_NOISE = 0x0404;
const CMD_MANAGE_DEVICE = 0x0429;
const REPLY = 0x8000;

/* The first payload byte of a CMD_PUSH, and the event ids to subscribe to. */
const EVENT_BATTERY = 0x01;
const EVENT_WEAR = 0x02;
const EVENT_NOISE = 0x03;
const EVENT_DEVICES = 0x06;
const WANTED_EVENTS = [EVENT_BATTERY, EVENT_WEAR, EVENT_NOISE, EVENT_DEVICES];

/* Bits of the handshake reply's command bitmap: the device list, and
 * connecting and disconnecting the devices on it. */
const BIT_DEVICE_LIST = 29;
const BIT_MANAGE_DEVICES = 59;
const MANAGE_CONNECT = 0x01;
const MANAGE_DISCONNECT = 0x02;

/* How long after a connect or disconnect the list is read again: a
 * disconnect is quick, a connect can take a few seconds. */
const MANAGE_RECHECK_MS = [1500, 6000];

/* A wear state's bit for "in an ear"; bit 0 is out of the case, bit 2 the
 * case's lid open. */
const WEAR_IN_EAR = 0x02;

/* The noise control query and report are `01 01 <mode bits LE>`. */
const NOISE_CURRENT = [0x01, 0x01];

/* Battery report indexes. */
const PARTS = {1: 'left', 2: 'right', 3: 'case'};

/* Sequence numbers wrap below 0xC0: the vendor app keeps the top ones for
 * fixed-sequence queries. */
const SEQ_LIMIT = 0xc0;

/* The vendor's mode numbers. 'voice' is a transparency variant offered only
 * where each bud says it has it, which is not read here: it is shown as
 * transparency when the buds report it, and never offered. */
const MODE_TYPES = {
    1: 'off',
    2: 'transparency',
    3: 'light',
    4: 'deep',
    5: 'nc',
    6: 'voice',
    7: 'smart',
    8: 'medium',
    10: 'adaptive',
};

/* The modes this protocol has, in display order. */
const OPPO_MODES = ['off', 'transparency', 'nc', 'adaptive'];

function encodeLength(length) {
    const bytes = [];
    do {
        const low = length & 0x7f;
        length >>= 7;
        bytes.push(length ? low | 0x80 : low);
    } while (length);
    return bytes;
}

export function encodeFrame(cmd, seq, payload = []) {
    const n = payload.length;
    return new Uint8Array([
        0xaa, ...encodeLength(7 + n), 0x00, 0x00,
        cmd & 0xff, cmd >> 8 & 0xff, seq,
        n & 0xff, n >> 8 & 0xff, ...payload,
    ]);
}

/* `len` and the bytes it takes, null while incomplete, or -1 when three
 * bytes still have not ended it, which is no header. */
function readLength(buffer, start) {
    let length = 0;
    for (let i = 1; i <= 3; i++) {
        if (start + i >= buffer.length)
            return null;
        const byte = buffer[start + i];
        length |= (byte & 0x7f) << 7 * (i - 1);
        if (!(byte & 0x80))
            return [length, i];
    }
    return -1;
}

/* Splits the complete frames off `buffer`: [[{cmd, seq, payload}], rest].
 * Bytes before a frame are skipped. The slices of a long message (slice
 * byte 1 to 3) carry nothing read here and are skipped whole. */
export function parseFrames(buffer) {
    const messages = [];
    let pos = 0;

    while (pos < buffer.length) {
        if (buffer[pos] !== 0xaa) {
            pos++;
            continue;
        }

        const header = readLength(buffer, pos);
        if (header === null)
            break;
        if (header === -1) {
            pos++;
            continue;
        }

        const [length, lengthBytes] = header;
        const body = pos + 1 + lengthBytes;
        if (body >= buffer.length)
            break;

        const slice = buffer[body];
        const sliced = slice >= 1 && slice <= 3;
        const end = body + length;
        if (length < (sliced ? 4 : 7) || length > 2048) {
            pos++;
            continue;
        }
        if (end > buffer.length)
            break;

        if (!sliced) {
            const at = body + 2;
            const size = buffer[at + 3] | buffer[at + 4] << 8;
            messages.push({
                cmd: buffer[at] | buffer[at + 1] << 8,
                seq: buffer[at + 2],
                payload: buffer.slice(at + 5, Math.min(at + 5 + size, end)),
            });
        }
        pos = end;
    }

    return [messages, buffer.slice(pos)];
}

/* `<count> (<index> <level>)…` from `from`: {left, right, case}, each
 * {level, charging}, or null where the part is there but its level is not
 * known (0, as the case reports while it is shut). A part not reported is
 * left out. */
export function parseBattery(payload, from) {
    const result = {};
    const count = payload[from] ?? 0;
    for (let i = 0; i < count; i++) {
        const at = from + 1 + i * 2;
        if (at + 1 >= payload.length)
            break;
        const part = PARTS[payload[at]];
        if (!part)
            continue;
        const raw = payload[at + 1];
        const value = Math.min(raw & 0x7f, 100);
        result[part] = value ? {level: value, charging: (raw & 0x80) !== 0} : null;
    }
    return result;
}

/* `<count> (<part> <state>)…` from `from`: {left, right}, true for a bud in an
 * ear, or null if this is not a wear list. */
export function parseWear(payload, from) {
    const count = payload[from];
    if (!count || count > 8 || payload.length < from + 1 + count * 2)
        return null;

    const result = {left: false, right: false};
    for (let i = 0; i < count; i++) {
        const part = payload[from + 1 + i * 2];
        const state = payload[from + 2 + i * 2];
        if (part < 1 || part > 3 || state > 15)
            return null;
        if (PARTS[part] in result)
            result[PARTS[part]] = (state & WEAR_IN_EAR) !== 0;
    }
    return result;
}

/* The mode bits of a `01 01 <bits LE>` report from `from`, 0 if it is not one. */
export function parseNoiseBits(payload, from) {
    if (payload.length < from + 3 ||
        payload[from] !== NOISE_CURRENT[0] || payload[from + 1] !== NOISE_CURRENT[1])
        return 0;

    let bits = 0;
    const end = Math.min(payload.length, from + 6);
    for (let i = end - 1; i >= from + 2; i--)
        bits = bits * 256 + payload[i];
    return bits;
}

/* Whether bit `bit` of the handshake's command bitmap (least significant
 * bit first) is set. */
export function bitmapHas(bitmap, bit) {
    return ((bitmap[bit >> 3] ?? 0) >> (bit & 7) & 1) === 1;
}

/* `<count>` then `<MAC reversed, 6> <len> <state> <flags> <nameLen> <name>`
 * from `from`: [{address, name, connected, self, playing}], or null if the
 * list is cut short. `address` is "AA:BB:…", in the order the connect and
 * disconnect commands take it. Flags: bit 0 the device asking, bit 2
 * playing. `localAddresses` are this computer's, which the flag may miss. */
export function parseDevices(payload, from, localAddresses = []) {
    const count = payload[from];
    if (count === undefined)
        return null;

    const devices = [];
    let i = from + 1;
    for (let n = 0; n < count; n++) {
        if (i + 10 > payload.length)
            return null;
        const nameLength = payload[i + 9];
        if (i + 10 + nameLength > payload.length)
            return null;

        const address = [...payload.slice(i, i + 6)].reverse()
            .map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
        const flags = payload[i + 8];
        devices.push({
            address,
            /* Names come NUL-terminated, the NUL inside nameLen. */
            name: new TextDecoder().decode(payload.slice(i + 10, i + 10 + nameLength))
                .split('\0')[0],
            connected: payload[i + 7] === 2,
            self: (flags & 0x01) !== 0 || localAddresses.includes(address),
            playing: (flags & 0x04) !== 0,
        });
        i += 10 + nameLength;
    }
    return devices;
}

/* The payload that connects or disconnects the device at `address`. */
export function manageDevicePayload(connect, address) {
    return [connect ? MANAGE_CONNECT : MANAGE_DISCONNECT,
        ...address.split(':').map(part => parseInt(part, 16))];
}

function lowestBit(bits) {
    for (let bit = 0; bit < 32; bit++) {
        if (Math.floor(bits / 2 ** bit) % 2)
            return bit;
    }
    return -1;
}

function bitField(bit) {
    const bytes = new Array((bit >> 3) + 1).fill(0);
    bytes[bit >> 3] = 1 << (bit & 7);
    return bytes;
}

/* HeyMelody folds the colour variants of the first OnePlus Buds into one id. */
function normaliseProductId(id) {
    if (id >= 0x100100 && id <= 0x100102)
        return 0x060414;
    if (id >= 0x100200 && id <= 0x100202)
        return 0x060814;
    if (id >= 0x108100 && id <= 0x108102)
        return 0x068414;
    if (id >= 0x108200 && id <= 0x108202)
        return 0x068814;
    return id;
}

/* One model's noise control modes: the bit that sets each, and the mode each
 * reported bit means. A report can name a variant where a set names its
 * parent: some buds are set Off with bit 0 and report it as bit 3. */
export class NoiseTable {
    /* The table for a product id and model name, or null if the model has
     * none. As in HeyMelody, id and name first, then the name (some buds reuse
     * another model's id), then the id (renamed buds). */
    static forProduct(productId, name) {
        const id = normaliseProductId(productId).toString(16).toUpperCase().padStart(6, '0');
        const row = MODELS.find(([i, n]) => i === id && n === name) ??
            MODELS.find(([, n]) => n === name) ??
            MODELS.find(([i]) => i === id);
        return row ? new NoiseTable(row[2]) : null;
    }

    constructor(tree) {
        this._set = new Map();
        this._report = new Map();

        for (const [type, bit, variants = []] of tree) {
            const name = MODE_TYPES[type];
            if (!name)
                continue;
            const shown = name === 'voice' ? 'transparency' : name;
            if (name !== 'voice' && !this._set.has(name))
                this._set.set(name, bit);
            this._report.set(bit, shown);

            for (const [variantType, variantBit] of variants) {
                const variant = MODE_TYPES[variantType];
                if (!variant)
                    continue;
                if (variant !== name && variant !== 'voice' && !this._set.has(variant))
                    this._set.set(variant, variantBit);
                this._report.set(variantBit, variant === 'voice' ? shown : variant);
            }
        }

        this.levels = NOISE_LEVELS.filter(level => this._set.has(level));
        this.modes = OPPO_MODES.filter(mode => mode === 'nc'
            ? this._set.has('nc') || this.levels.length > 0
            : this._set.has(mode));
    }

    /* Noise cancelling with no level asked for: the level the plain mode
     * stands for, else Smart, else the strongest. */
    get defaultLevel() {
        if (this.levels.length === 0)
            return null;
        const ncBit = this._set.get('nc');
        return this.levels.find(level => this._set.get(level) === ncBit) ??
            (this.levels.includes('smart') ? 'smart' : this.levels.at(-1));
    }

    /* The bit that sets `mode` (at `level` for noise cancelling), or null.
     * Buds with levels are always set by level, as the vendor app does. */
    bitFor(mode, level = null) {
        if (mode !== 'nc')
            return this._set.get(mode) ?? null;
        if (this.levels.length === 0)
            return this._set.get('nc') ?? null;
        const chosen = this.levels.includes(level) ? level : this.defaultLevel;
        return this._set.get(chosen);
    }

    /* {mode, level} for reported mode bits, or null for a bit the table does
     * not know. `level` is null where the report names none. */
    read(bits) {
        const name = this._report.get(lowestBit(bits));
        if (!name)
            return null;
        if (NOISE_LEVELS.includes(name))
            return {mode: 'nc', level: name};
        return {mode: name, level: null};
    }
}

const OppoSession = GObject.registerClass(
class OppoSession extends ChannelSession {
    _init(fd, info) {
        super._init(fd, info);
        this._seq = 0;
        this._noiseTable = null;
        this._noiseBits = 0;
        this._level = null;
        this._bitmap = [];
    }

    _start() {
        /* The handshake comes first or later commands go unanswered. The
         * events offered come back in a reply that triggers the subscription. */
        this._command(CMD_HANDSHAKE);
        this._command(CMD_PRODUCT_ID);
        this._command(CMD_QUERY_EVENTS);
        this._command(CMD_QUERY_BATTERY);
        this._command(CMD_QUERY_WEAR);
    }

    refresh() {
        this._command(CMD_QUERY_BATTERY);
        this._command(CMD_QUERY_WEAR);
        if (this._noiseTable)
            this._command(CMD_QUERY_NOISE, NOISE_CURRENT);
        if (bitmapHas(this._bitmap, BIT_DEVICE_LIST))
            this._command(CMD_QUERY_DEVICES);
    }

    connectDevice(address) {
        this._manageDevice(true, address);
    }

    disconnectDevice(address) {
        this._manageDevice(false, address);
    }

    _manageDevice(connect, address) {
        const device = this.devices?.find(d => d.address === address);
        if (!this.canManageDevices || !device || device.self)
            return;

        this._command(CMD_MANAGE_DEVICE, manageDevicePayload(connect, address));
        /* Shown as under way until the list says otherwise. */
        this.devices = this.devices.map(d => d === device ? {...d, pending: connect ? 'connect' : 'disconnect'} : d);
        this._changed();
        for (const delay of MANAGE_RECHECK_MS)
            this._later(delay, () => this._command(CMD_QUERY_DEVICES));
    }

    setNoise(mode, level = null) {
        const table = this._noiseTable;
        if (!table)
            return;
        const bit = table.bitFor(mode, level ?? this._level);
        if (bit === null || bit === undefined)
            return;

        this._command(CMD_SET_NOISE, [...NOISE_CURRENT, ...bitField(bit)]);
        const state = table.read(2 ** bit) ?? {mode, level: null};
        if (state.level)
            this._level = state.level;
        this._expectNoise(state, () => this._command(CMD_QUERY_NOISE, NOISE_CURRENT));
    }

    _command(cmd, payload = []) {
        this._send(encodeFrame(cmd, this._seq, payload));
        this._seq = (this._seq + 1) % SEQ_LIMIT;
    }

    _parse(buffer) {
        const [messages, rest] = parseFrames(buffer);
        let changed = false;
        for (const message of messages)
            changed = this._handle(message) || changed;
        if (changed)
            this._changed();
        return rest;
    }

    /* True when the state changed. */
    _handle({cmd, payload}) {
        const ok = payload[0] === 0;

        switch (cmd) {
        case CMD_HANDSHAKE | REPLY:
            /* The commands these buds take. */
            if (!ok)
                return false;
            this._bitmap = [...payload.subarray(1)];
            this.canManageDevices = bitmapHas(this._bitmap, BIT_MANAGE_DEVICES);
            if (bitmapHas(this._bitmap, BIT_DEVICE_LIST))
                this._command(CMD_QUERY_DEVICES);
            return false;

        case CMD_QUERY_DEVICES | REPLY:
            return ok && this._setDevices(parseDevices(payload, 1, this.info.localAddresses));

        case CMD_MANAGE_DEVICE | REPLY:
            /* Turned down: show the list as it really is. */
            if (!ok)
                this._command(CMD_QUERY_DEVICES);
            return false;

        case CMD_PRODUCT_ID | REPLY: {
            if (!ok || payload.length < 4)
                return false;
            const id = payload[1] | payload[2] << 8 | payload[3] << 16;
            this._noiseTable = NoiseTable.forProduct(id, this.info.name);
            if (!this._noiseTable)
                return false;
            this.noiseModes = this._noiseTable.modes;
            this.noiseLevels = this._noiseTable.levels;
            /* A push can come before the table that reads it. */
            if (this._noiseBits)
                this._setNoiseBits(this._noiseBits);
            this._command(CMD_QUERY_NOISE, NOISE_CURRENT);
            return true;
        }

        case CMD_QUERY_EVENTS | REPLY: {
            if (!ok || payload.length < 2)
                return false;
            /* As HeyMelody does, only what the buds offer: some firmware
             * ignores a list with others in it. */
            const offered = [...payload.subarray(2, 2 + payload[1])];
            const events = WANTED_EVENTS.filter(id => offered.includes(id));
            if (events.length > 0)
                this._command(CMD_SUBSCRIBE, [events.length, ...events]);
            return false;
        }

        case CMD_QUERY_BATTERY | REPLY:
            return ok && this._setBattery(parseBattery(payload, 1));

        case CMD_QUERY_NOISE | REPLY:
            return ok && this._setNoiseBits(parseNoiseBits(payload, 1));

        case CMD_SET_NOISE | REPLY:
            if (ok)
                return false;
            /* Turned down, as while no bud is worn: say so, and read back the
             * mode the buds kept. */
            this.refused = true;
            this._noiseConfirmed();
            this._command(CMD_QUERY_NOISE, NOISE_CURRENT);
            this._command(CMD_QUERY_WEAR);
            return true;

        case CMD_QUERY_WEAR | REPLY:
            /* Some firmware puts a status byte first, some does not. */
            return this._setWear((ok && parseWear(payload, 1)) || parseWear(payload, 0));

        case CMD_PUSH:
            if (payload[0] === EVENT_BATTERY)
                return this._setBattery(parseBattery(payload, 1));
            if (payload[0] === EVENT_WEAR)
                return this._setWear(parseWear(payload, 1));
            if (payload[0] === EVENT_NOISE)
                return this._setNoiseBits(parseNoiseBits(payload, 1));
            if (payload[0] === EVENT_DEVICES)
                return this._setDevices(parseDevices(payload, 1, this.info.localAddresses));
            return false;
        }

        return false;
    }

    _setDevices(devices) {
        if (!devices)
            return false;
        this.devices = devices;
        return true;
    }

    _setBattery(parts) {
        if (Object.keys(parts).length === 0)
            return false;
        this.battery = {...this.battery, ...parts};
        return true;
    }

    _setWear(wear) {
        if (!wear)
            return false;
        /* Put in an ear, the buds take a change again. */
        const wasWorn = !!(this.wear?.left || this.wear?.right);
        if (!wasWorn && (wear.left || wear.right))
            this.refused = false;
        this.wear = wear;
        return true;
    }

    _setNoiseBits(bits) {
        if (!bits)
            return false;
        this._noiseBits = bits;
        const state = this._noiseTable?.read(bits);
        if (!state)
            return false;
        this._noiseConfirmed();
        /* A report that names no level keeps the one in use. */
        if (state.mode === 'nc')
            state.level ??= this._level;
        if (state.level)
            this._level = state.level;
        this.noise = state;
        return true;
    }
});

export default {
    id: 'oppo',
    match: info => info.uuids.includes(OPPO_UUID) ? OPPO_UUID : null,
    Session: OppoSession,
};
