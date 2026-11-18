// SPDX-License-Identifier: GPL-3.0-or-later
/* backends/nothing.js: Nothing and CMF earbuds, the protocol of the Nothing X
 * app. Battery of each bud and the case, and noise control: off,
 * transparency, and noise cancelling at the levels the model reports, plus
 * adaptive where it has it.
 *
 * A frame is `55 <control LE16> <command LE16> <length LE16> <counter>
 * <payload> [<CRC-16/MODBUS LE>]`, the CRC there when control bit 5 is set.
 * A reply carries the request's command with the top bit clear. Follows
 * Gadgetbridge's reverse engineering. */

import GObject from 'gi://GObject';

import {ChannelSession} from '../session.js';

const NOTHING_UUID = 'aeac4a03-dff5-498f-843a-34487cf133eb';

const CONTROL = 0x0120;
const CONTROL_BATTERY = 0x5120;
const CONTROL_CRC = 0x20;
const CONTROL_COUNTER = 0x40;

const CMD_BATTERY = 0xc007;
const CMD_BATTERY_PUSH = 0xe001;
const CMD_NOISE = 0xc01e;
const CMD_SET_NOISE = 0xf00f;

const PARTS = {0x02: 'left', 0x03: 'right', 0x04: 'case'};

/* Noise control values: ANC high, mid and low are its levels. */
const NOISE_STATES = {
    0x01: {mode: 'nc', level: 'deep'},
    0x02: {mode: 'nc', level: 'medium'},
    0x03: {mode: 'nc', level: 'light'},
    0x04: {mode: 'adaptive', level: null},
    0x05: {mode: 'off', level: null},
    0x07: {mode: 'transparency', level: null},
};

export function crc16modbus(bytes) {
    let crc = 0xffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
            crc = crc & 1 ? crc >>> 1 ^ 0xa001 : crc >>> 1;
    }
    return crc;
}

export function encodeNothing(control, command, payload, counter) {
    const n = payload.length;
    const frame = [0x55, control & 0xff, control >> 8, command & 0xff, command >> 8,
        n & 0xff, n >> 8, counter & 0xff, ...payload];
    if (control & CONTROL_CRC) {
        const crc = crc16modbus(frame);
        frame.push(crc & 0xff, crc >> 8);
    }
    return new Uint8Array(frame);
}

/* [[{control, command, payload}], rest]. */
export function parseNothing(buffer) {
    const messages = [];
    let pos = 0;
    while (pos < buffer.length) {
        if (buffer[pos] !== 0x55) {
            pos++;
            continue;
        }
        if (pos + 8 > buffer.length)
            break;
        const control = buffer[pos + 1] | buffer[pos + 2] << 8;
        const length = buffer[pos + 5] | buffer[pos + 6] << 8;
        const end = pos + 8 + length + (control & CONTROL_CRC ? 2 : 0);
        if (length > 1024) {
            pos++;
            continue;
        }
        if (end > buffer.length)
            break;
        messages.push({
            control,
            command: buffer[pos + 3] | buffer[pos + 4] << 8,
            payload: buffer.slice(pos + 8, pos + 8 + length),
        });
        pos = end;
    }
    return [messages, buffer.slice(pos)];
}

const NothingSession = GObject.registerClass(
class NothingSession extends ChannelSession {
    _init(fd, info) {
        super._init(fd, info);
        /* Ear (stick) numbers its frames. */
        this._counting = /stick/i.test(info.name);
        this._counter = 0;
    }

    _start() {
        this._command(CONTROL_BATTERY, CMD_BATTERY);
        this._command(CONTROL, CMD_NOISE);
    }

    refresh() {
        this._start();
    }

    setNoise(mode, level = null) {
        if (!this.noiseModes.includes(mode))
            return;
        const wanted = mode === 'nc' ? level ?? this.noise?.level ?? 'deep' : null;
        const value = Object.keys(NOISE_STATES).map(Number).find(key =>
            NOISE_STATES[key].mode === mode && (mode !== 'nc' || NOISE_STATES[key].level === wanted));
        if (value === undefined)
            return;
        this._command(CONTROL, CMD_SET_NOISE, [0x01, value, 0x00]);
        this._expectNoise(NOISE_STATES[value], () => this._command(CONTROL, CMD_NOISE));
    }

    _command(control, command, payload = []) {
        if (this._counting)
            control |= CONTROL_COUNTER;
        this._send(encodeNothing(control, command, payload, this._counting ? this._counter : 0));
        if (this._counting)
            this._counter = (this._counter + 1) % 0xfd;
    }

    _parse(buffer) {
        const [messages, rest] = parseNothing(buffer);
        for (const message of messages)
            this._handle(message);
        return rest;
    }

    _handle({control, command, payload}) {
        /* Low 5 bits: an error code; bits 8-11: the device type, 1 for buds. */
        if (control & 0x1f || (control & 0x0f00) >> 8 !== 1)
            return;

        switch (command | 0x8000) {
        case CMD_BATTERY:
        case CMD_BATTERY_PUSH:
            this._onBattery(payload);
            break;
        case CMD_NOISE:
            if (payload.length >= 2)
                this._onNoise(payload[1]);
            break;
        }
    }

    _onBattery(payload) {
        const battery = {};
        for (let i = 0; i < payload[0]; i++) {
            const part = PARTS[payload[1 + i * 2]];
            const raw = payload[2 + i * 2];
            if (!part || raw === undefined)
                continue;
            const value = raw & 0x7f;
            battery[part] = value > 0 && value <= 100 ? {level: value, charging: (raw & 0x80) !== 0} : null;
        }
        this.battery = {...this.battery, ...battery};
        this._changed();
    }

    _onNoise(value) {
        const state = NOISE_STATES[value];
        if (!state)
            return;
        /* The modes and levels grow with what the buds report: Ear (1) has
         * two levels, newer models three and adaptive. */
        const modes = new Set([...this.noiseModes, 'off', 'transparency', 'nc', state.mode]);
        this.noiseModes = ['off', 'transparency', 'nc', 'adaptive'].filter(mode => modes.has(mode));
        const levels = new Set([...this.noiseLevels, 'light', 'deep', ...state.level ? [state.level] : []]);
        this.noiseLevels = ['light', 'medium', 'deep'].filter(l => levels.has(l));
        this.noise = state;
        this._noiseConfirmed();
        this._changed();
    }
});

export default {
    id: 'nothing',
    match: info => info.uuids.includes(NOTHING_UUID) ? NOTHING_UUID : null,
    Session: NothingSession,
};
