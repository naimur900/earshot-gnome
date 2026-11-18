// SPDX-License-Identifier: GPL-3.0-or-later
/* backends/xiaomi.js: Xiaomi and Redmi earbuds, the protocol of the Xiaomi
 * Earbuds app. Battery of each bud and the case, and noise control: off,
 * noise cancelling, transparency, and the cancelling strength where the
 * model has one.
 *
 * A frame is `FE DC BA <type> <opcode> <length BE16> [00] <seq> <payload> EF`;
 * the 00 status byte is in replies only, and the length counts it, the
 * sequence number and the payload. The buds answer nothing until each side
 * has answered the other's challenge (xiaomiAuth.js). Follows Gadgetbridge's
 * reverse engineering of the Redmi Buds 5 Pro. */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {ChannelSession, indexOfBytes, level} from '../session.js';
import {answerChallenge} from './xiaomiAuth.js';

const XIAOMI_UUID = '0000fd2d-0000-1000-8000-00805f9b34fb';

const HEADER = [0xfe, 0xdc, 0xba];
const TRAILER = 0xef;

const TYPE_PHONE_REQUEST = 0xc4;
const TYPE_RESPONSE = 0x04;

const OP_DEVICE_INFO = 0x02;
const OP_NOISE = 0x08;
const OP_RUN_INFO = 0x09;
const OP_REPORT = 0x0e;
const OP_CHALLENGE = 0x50;
const OP_CONFIRM = 0x51;
const OP_SET_CONFIG = 0xf2;
const OP_GET_CONFIG = 0xf3;
const OP_NOTIFY_CONFIG = 0xf4;

const CONFIG_STRENGTH = 0x0b;
const STRENGTH_ANC = 0x01;

const MODES = {0: 'off', 1: 'nc', 2: 'transparency'};
const MODE_VALUES = {off: 0, nc: 1, transparency: 2};
/* Cancelling strengths: balanced, light, deep. */
const LEVELS = {0: 'medium', 1: 'light', 2: 'deep'};
const LEVEL_VALUES = {medium: 0, light: 1, deep: 2};

const isRequest = type => (type & 0x40) !== 0;

export function encodeXiaomi(type, opcode, seq, payload = []) {
    const status = isRequest(type) ? [] : [0x00];
    const length = status.length + 1 + payload.length;
    return new Uint8Array([...HEADER, type, opcode, length >> 8, length & 0xff,
        ...status, seq, ...payload, TRAILER]);
}

/* [[{type, opcode, seq, payload}], rest]. */
export function parseXiaomi(buffer) {
    const messages = [];
    let pos = 0;
    for (;;) {
        const start = indexOfBytes(buffer, HEADER, pos);
        if (start < 0)
            return [messages, buffer.slice(Math.max(pos, buffer.length - 2))];
        if (start + 7 > buffer.length)
            return [messages, buffer.slice(start)];

        const type = buffer[start + 3];
        const length = buffer[start + 5] << 8 | buffer[start + 6];
        const end = start + 7 + length + 1;
        if (end > buffer.length)
            return [messages, buffer.slice(start)];
        if (buffer[end - 1] !== TRAILER || length < (isRequest(type) ? 1 : 2)) {
            pos = start + 1;
            continue;
        }

        const seqAt = start + 7 + (isRequest(type) ? 0 : 1);
        messages.push({
            type,
            opcode: buffer[start + 4],
            seq: buffer[seqAt],
            payload: buffer.slice(seqAt + 1, end - 1),
        });
        pos = end;
    }
}

/* Each entry of a `<length> <id> <data…>` list, as [id, data]. */
function* entries(payload) {
    let i = 0;
    while (i + 1 < payload.length) {
        const length = payload[i];
        yield [payload[i + 1], payload.slice(i + 2, i + 1 + length)];
        i += length + 1;
    }
}

function readBattery(data) {
    const read = raw => raw === 0xff ? null : level(raw & 0x7f, {charging: (raw & 0x80) !== 0});
    return {left: read(data[0]), right: read(data[1]), case: read(data[2])};
}

const XiaomiSession = GObject.registerClass(
class XiaomiSession extends ChannelSession {
    _init(fd, info) {
        super._init(fd, info);
        this._seq = 0;
        this._ready = false;
        this._level = null;
    }

    _start() {
        const challenge = Array.from({length: 16}, () => GLib.random_int_range(0, 256));
        this._request(OP_CHALLENGE, [0x01, ...challenge]);
    }

    refresh() {
        if (this._ready)
            this._queryState();
    }

    setNoise(mode, level = null) {
        if (!this.noiseModes.includes(mode))
            return;
        this._request(OP_NOISE, [0x02, 0x04, MODE_VALUES[mode]]);
        if (mode === 'nc' && level && this.noiseLevels.includes(level))
            this._request(OP_SET_CONFIG, [0x04, 0x00, CONFIG_STRENGTH, STRENGTH_ANC, LEVEL_VALUES[level]]);
        const state = {mode, level: mode === 'nc' ? level ?? this.noise?.level ?? null : null};
        this._expectNoise(state, () => this._queryState());
    }

    _request(opcode, payload) {
        this._send(encodeXiaomi(TYPE_PHONE_REQUEST, opcode, this._seq, payload));
        this._seq = (this._seq + 1) & 0xff;
    }

    _respond(opcode, seq, payload = []) {
        this._send(encodeXiaomi(TYPE_RESPONSE, opcode, seq, payload), {urgent: true});
    }

    _queryState() {
        const all = [0xff, 0xff, 0xff, 0xff];
        this._request(OP_DEVICE_INFO, all);
        this._request(OP_RUN_INFO, all);
        this._request(OP_GET_CONFIG, [0x00, CONFIG_STRENGTH]);
    }

    _parse(buffer) {
        const [messages, rest] = parseXiaomi(buffer);
        for (const message of messages)
            this._handle(message);
        return rest;
    }

    _handle({type, opcode, seq, payload}) {
        const request = isRequest(type);

        switch (opcode) {
        case OP_CHALLENGE:
            if (!request) {
                /* They took our challenge: confirm. */
                this._request(OP_CONFIRM, [0x01, 0x00]);
            } else if (payload.length >= 17) {
                this._respond(OP_CHALLENGE, seq, [0x01, ...answerChallenge(payload.slice(1, 17))]);
            }
            break;

        case OP_CONFIRM:
            if (request) {
                this._respond(OP_CONFIRM, seq, [0x01]);
                this._ready = true;
                this._queryState();
            }
            break;

        case OP_DEVICE_INFO:
            for (const [id, data] of entries(payload)) {
                if (id === 0x07 && data.length >= 3)
                    this._setBattery(readBattery(data));
            }
            break;

        case OP_RUN_INFO:
            for (const [id, data] of entries(payload)) {
                if (id === 0x09)
                    this._setMode(data[0]);
            }
            break;

        case OP_REPORT:
            for (const [id, data] of entries(payload)) {
                if (id === 0x00 && data.length >= 3)
                    this._setBattery(readBattery(data));
                else if (id === 0x04)
                    this._setMode(data[0]);
            }
            this._respond(OP_REPORT, seq);
            break;

        case OP_GET_CONFIG:
            if (payload[2] === CONFIG_STRENGTH && payload[3] === STRENGTH_ANC)
                this._setLevel(payload[4]);
            break;

        case OP_NOTIFY_CONFIG: {
            let i = 0;
            while (i + 4 < payload.length) {
                if (payload[i + 2] === CONFIG_STRENGTH && payload[i + 3] === STRENGTH_ANC)
                    this._setLevel(payload[i + 4]);
                i += payload[i] + 1;
            }
            this._respond(OP_NOTIFY_CONFIG, seq);
            break;
        }
        }
    }

    _setBattery(parts) {
        this.battery = {...this.battery, ...parts};
        this._changed();
    }

    _setMode(value) {
        const mode = MODES[value];
        if (!mode)
            return;
        this.noiseModes = ['off', 'transparency', 'nc'];
        this.noise = {mode, level: mode === 'nc' ? this._level ?? null : null};
        this._noiseConfirmed();
        this._changed();
    }

    /* Models with a strength answer for it; the rest have no levels. */
    _setLevel(value) {
        const name = LEVELS[value];
        if (!name)
            return;
        this._level = name;
        this.noiseLevels = ['light', 'medium', 'deep'];
        if (this.noise?.mode === 'nc')
            this.noise = {mode: 'nc', level: name};
        this._changed();
    }
});

export default {
    id: 'xiaomi',
    match: info => info.uuids.includes(XIAOMI_UUID) ? XIAOMI_UUID : null,
    Session: XiaomiSession,
};
