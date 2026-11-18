// SPDX-License-Identifier: GPL-3.0-or-later
/* backends/sony.js: Sony headphones and earbuds (WH-1000XM, WF-1000XM, LinkBuds
 * and others), the protocol of Sony's Headphones Connect app. Battery of the
 * headphones, or of each bud and the case, and ambient sound control: off,
 * ambient sound, noise cancelling, and wind noise reduction where the model
 * has it.
 *
 * A frame is `3E <type> <seq> <length BE32> <payload> <checksum> 3C`, the
 * checksum the low byte of the sum of what is between the markers, and any
 * 3C, 3D or 3E in there escaped as 3D followed by the byte with bit 4 clear.
 * Each command is acknowledged with an ACK frame whose sequence number the
 * next command carries. There are two protocol versions, told apart by the
 * length of the reply to the first command. Follows Gadgetbridge's reverse
 * engineering. */

import GObject from 'gi://GObject';

import {ChannelSession} from '../session.js';

const UUID_V1 = '96cc203e-5068-46ad-b32d-e316f5e069ba';
const UUID_V2 = '956c7b26-d49a-4ba8-b03f-b17d393cb6e2';

const START = 0x3e;
const END = 0x3c;
const ESCAPE = 0x3d;

const TYPE_ACK = 0x01;
const TYPE_COMMAND = 0x0c;
const TYPE_COMMAND_2 = 0x0e;

const INIT_REQUEST = 0x00;
const INIT_REPLY = 0x01;
const AMBIENT_GET = 0x66;
const AMBIENT_RET = 0x67;
const AMBIENT_SET = 0x68;
const AMBIENT_NOTIFY = 0x69;

/* Per version: the battery commands, and the battery kinds by the codes the
 * replies carry them under. */
const VERSIONS = {
    1: {
        batteryGet: 0x10,
        batteryReplies: [0x11, 0x13],
        kinds: {0x00: 'single', 0x01: 'dual', 0x02: 'case'},
    },
    2: {
        batteryGet: 0x22,
        batteryReplies: [0x23, 0x25],
        kinds: {0x00: 'single', 0x01: 'dual', 0x09: 'dual', 0x0a: 'case'},
    },
};

/* The ambient sound level used when none has been read: midway. */
const DEFAULT_AMBIENT_LEVEL = 10;

export function sonyChecksum(bytes) {
    return bytes.reduce((sum, byte) => (sum + byte) & 0xff, 0);
}

export function encodeSony(type, seq, payload) {
    const n = payload.length;
    const body = [type, seq, n >>> 24 & 0xff, n >> 16 & 0xff, n >> 8 & 0xff, n & 0xff, ...payload];
    body.push(sonyChecksum(body));

    const out = [START];
    for (const byte of body) {
        if (byte === START || byte === END || byte === ESCAPE)
            out.push(ESCAPE, byte & 0xef);
        else
            out.push(byte);
    }
    out.push(END);
    return new Uint8Array(out);
}

/* [[{type, seq, payload}], rest]. Frames with a bad checksum are dropped. */
export function parseSony(buffer) {
    const messages = [];
    let pos = 0;

    while (pos < buffer.length) {
        const start = buffer.indexOf(START, pos);
        if (start < 0)
            return [messages, new Uint8Array(0)];
        const end = buffer.indexOf(END, start + 1);
        if (end < 0)
            return [messages, buffer.slice(start)];

        const body = [];
        for (let i = start + 1; i < end; i++) {
            if (buffer[i] === ESCAPE && i + 1 < end)
                body.push(buffer[++i] | 0x10);
            else
                body.push(buffer[i]);
        }
        pos = end + 1;

        if (body.length < 7)
            continue;
        const length = (body[2] << 24 >>> 0) + (body[3] << 16) + (body[4] << 8) + body[5];
        if (length !== body.length - 7 || sonyChecksum(body.slice(0, -1)) !== body.at(-1))
            continue;
        messages.push({type: body[0], seq: body[1], payload: Uint8Array.from(body.slice(6, -1))});
    }

    return [messages, new Uint8Array(0)];
}

/* The ambient sound settings from a reply or notification: {variant, mode,
 * wind, focus, level}, `wind` whether the model has wind noise reduction, or
 * null if this is not one. */
export function parseAmbient(version, payload) {
    if (version === 1) {
        if (payload.length !== 8)
            return null;
        const wind = payload[3] === 0x02;
        let mode = null;
        if (payload[2] === 0x00)
            mode = 'off';
        else if (wind)
            mode = {0: 'transparency', 1: 'wind', 2: 'nc'}[payload[4]] ?? null;
        else
            mode = {0: 'transparency', 1: 'nc'}[payload[4]] ?? null;
        return mode ? {variant: 0x02, mode, wind, focus: payload[6], level: payload[7]} : null;
    }

    if ((payload.length !== 7 && payload.length !== 8) ||
        (payload[1] !== 0x15 && payload[1] !== 0x17))
        return null;
    const wind = payload[1] === 0x17 && payload.length > 7;
    let mode = null;
    if (payload[3] === 0x00)
        mode = 'off';
    else if (wind && (payload[5] === 0x03 || payload[5] === 0x05))
        mode = 'wind';
    else
        mode = {0: 'nc', 1: 'transparency'}[payload[4]] ?? null;
    const at = wind ? 6 : 5;
    return mode ? {variant: payload[1], mode, wind, focus: payload[at], level: payload[at + 1]} : null;
}

/* The payload that sets `mode`, keeping the voice focus and ambient level
 * the headphones last reported. */
export function buildAmbientSet(version, current, mode) {
    const {variant, wind, focus = 0} = current;
    const level = current.level ?? DEFAULT_AMBIENT_LEVEL;

    if (version === 1) {
        const modeByte = wind
            ? {nc: 2, wind: 1}[mode] ?? 0
            : mode === 'nc' ? 1 : 0;
        const keepsLevel = mode === 'off' || mode === 'transparency';
        return [AMBIENT_SET, 0x02, mode === 'off' ? 0x00 : 0x11, wind ? 0x02 : 0x00,
            modeByte, 0x01, focus, keepsLevel ? level : 0];
    }

    const payload = [AMBIENT_SET, variant, 0x01, mode === 'off' ? 0x00 : 0x01,
        mode === 'transparency' ? 0x01 : 0x00];
    if (wind)
        payload.push(mode === 'wind' ? 0x03 : 0x02);
    payload.push(focus, level);
    return payload;
}

const SonySession = GObject.registerClass(
class SonySession extends ChannelSession {
    _init(fd, info) {
        super._init(fd, info);
        this.sendGapMs = 50;
        this._seq = 0;
        this._version = null;
        this._ambient = null;
        this._dual = false;
    }

    _start() {
        this._command([INIT_REQUEST, 0x00]);
    }

    refresh() {
        if (!this._version)
            return;
        this._queryBattery();
        this._queryAmbient();
    }

    setNoise(mode) {
        if (!this._ambient || !this.noiseModes.includes(mode))
            return;
        this._command(buildAmbientSet(this._version, this._ambient, mode));
        this._expectNoise({mode, level: null}, () => this._queryAmbient());
    }

    _command(payload, type = TYPE_COMMAND) {
        this._send(encodeSony(type, this._seq, payload), {waitAck: true});
    }

    _queryBattery() {
        const {batteryGet} = VERSIONS[this._version];
        const codes = this._version === 1 ? [0x00, 0x01, 0x02] : [0x00, 0x09, 0x01, 0x0a];
        for (const code of codes)
            this._command([batteryGet, code]);
    }

    _queryAmbient() {
        /* v2 has two layouts; the reply says which. The plain one is asked
         * first, so the fuller one wins where both answer. */
        if (this._version === 1) {
            this._command([AMBIENT_GET, 0x02]);
        } else {
            this._command([AMBIENT_GET, 0x15]);
            this._command([AMBIENT_GET, 0x17]);
        }
    }

    _parse(buffer) {
        const [messages, rest] = parseSony(buffer);
        for (const message of messages)
            this._handle(message);
        return rest;
    }

    _handle({type, seq, payload}) {
        if (type === TYPE_ACK) {
            /* A repeated ACK carries the number already in use. */
            if (seq === this._seq)
                return;
            this._seq = seq;
            this._acked();
            return;
        }
        if (type !== TYPE_COMMAND && type !== TYPE_COMMAND_2)
            return;

        this._send(encodeSony(TYPE_ACK, 1 - seq & 0xff, []), {urgent: true});
        if (payload.length === 0 || type !== TYPE_COMMAND)
            return;

        if (payload[0] === INIT_REPLY && !this._version) {
            this._version = payload.length === 8 ? 2 : 1;
            this._queryBattery();
            this._queryAmbient();
            return;
        }
        if (!this._version)
            return;

        if (VERSIONS[this._version].batteryReplies.includes(payload[0]))
            this._onBattery(payload);
        else if (payload[0] === AMBIENT_RET || payload[0] === AMBIENT_NOTIFY)
            this._onAmbient(payload);
    }

    _onBattery(payload) {
        const kind = VERSIONS[this._version].kinds[payload[1]];
        const read = (value, charging) =>
            value > 0 && value <= 100 ? {level: value, charging: charging === 1} : null;

        if (kind === 'dual' && payload.length >= 6) {
            this._dual = true;
            const battery = {...this.battery, left: read(payload[2], payload[3]),
                right: read(payload[4], payload[5])};
            delete battery.device;
            this.battery = battery;
        } else if (kind === 'case' && payload.length >= 4) {
            this.battery = {...this.battery, case: read(payload[2], payload[3])};
        } else if (kind === 'single' && payload.length >= 4 && !this._dual) {
            this.battery = {...this.battery, device: read(payload[2], payload[3])};
        } else {
            return;
        }
        this._changed();
    }

    _onAmbient(payload) {
        const ambient = parseAmbient(this._version, payload);
        if (!ambient)
            return;
        this._ambient = ambient;
        this.noiseModes = ['off', 'transparency', 'nc', ...ambient.wind ? ['wind'] : []];
        this.noise = {mode: ambient.mode, level: null};
        this._noiseConfirmed();
        this._changed();
    }
});

export default {
    id: 'sony',
    match(info) {
        if (info.uuids.includes(UUID_V2))
            return UUID_V2;
        if (info.uuids.includes(UUID_V1))
            return UUID_V1;
        return null;
    },
    Session: SonySession,
};
