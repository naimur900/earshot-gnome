// SPDX-License-Identifier: GPL-3.0-or-later
/* backends/soundcore.js: Anker Soundcore earbuds (the Liberty and Space
 * lines), the protocol of the Soundcore app. Battery of each bud and the
 * case, and noise control: off, transparency and noise cancelling.
 *
 * A frame from the computer is `08 EE 00 00 00 <command LE16> <length LE16>
 * <payload> <checksum>`, from the buds `09 FF 00 00 01 …` alike; the length
 * counts the whole frame and the checksum is the low byte of the sum of the
 * rest. Follows Gadgetbridge's reverse engineering of the Liberty 4 NC. */

import GObject from 'gi://GObject';

import {ChannelSession, indexOfBytes} from '../session.js';

/* Every model has its own service, all under one prefix. */
const UUID_PREFIX = '0cf12d31-fac3-4553-bd80-d6832e7b';

const HOST_HEADER = [0x08, 0xee, 0x00, 0x00, 0x00];
/* The two bytes after it are not checked; the fifth says "from the buds". */
const DEVICE_START = [0x09, 0xff];
const FROM_DEVICE = 0x01;

const CMD_DEVICE_INFO = 0x0101;
const CMD_BATTERY = 0x0301;
const CMD_SOUND_MODE = 0x0106;
const CMD_SET_SOUND_MODE = 0x8106;

const MODES = {0: 'nc', 1: 'transparency', 2: 'off'};
const MODE_VALUES = {nc: 0, transparency: 1, off: 2};

export function encodeSoundcore(command, payload = []) {
    const frame = [...HOST_HEADER, command & 0xff, command >> 8,
        0, 0, ...payload];
    const length = frame.length + 1;
    frame[7] = length & 0xff;
    frame[8] = length >> 8;
    frame.push(frame.reduce((sum, byte) => (sum + byte) & 0xff, 0));
    return new Uint8Array(frame);
}

/* [[{command, payload}], rest]. */
export function parseSoundcore(buffer) {
    const messages = [];
    let pos = 0;
    for (;;) {
        const start = indexOfBytes(buffer, DEVICE_START, pos);
        if (start < 0)
            return [messages, buffer.slice(Math.max(pos, buffer.length - 1))];
        if (start + 9 > buffer.length)
            return [messages, buffer.slice(start)];
        const length = buffer[start + 7] | buffer[start + 8] << 8;
        if (buffer[start + 4] !== FROM_DEVICE || length < 10 || length > 1024) {
            pos = start + 1;
            continue;
        }
        if (start + length > buffer.length)
            return [messages, buffer.slice(start)];
        messages.push({
            command: buffer[start + 5] | buffer[start + 6] << 8,
            payload: buffer.slice(start + 9, start + length - 1),
        });
        pos = start + length;
    }
}

const SoundcoreSession = GObject.registerClass(
class SoundcoreSession extends ChannelSession {
    _init(fd, info) {
        super._init(fd, info);
        /* Strength, voice focus, adaptive and wind bytes, kept as reported. */
        this._extras = [0x10, 0x00, 0x01, 0x00];
    }

    _start() {
        this._send(encodeSoundcore(CMD_DEVICE_INFO));
    }

    refresh() {
        this._start();
    }

    setNoise(mode) {
        if (!this.noiseModes.includes(mode))
            return;
        this._send(encodeSoundcore(CMD_SET_SOUND_MODE, [MODE_VALUES[mode], ...this._extras, 0x01]));
        this._expectNoise({mode, level: null}, () => this._start());
    }

    _parse(buffer) {
        const [messages, rest] = parseSoundcore(buffer);
        for (const {command, payload} of messages) {
            if (command === CMD_BATTERY && payload.length >= 3)
                this._onBattery(payload);
            else if (command === CMD_SOUND_MODE && payload.length >= 5)
                this._onSoundMode(payload);
        }
        return rest;
    }

    /* Levels come in fifths. */
    _onBattery(payload) {
        const read = value => value > 0 && value <= 5 ? {level: value * 20, charging: false} : null;
        this.battery = {left: read(payload[0]), right: read(payload[1]), case: read(payload[2])};
        this._changed();
    }

    _onSoundMode(payload) {
        const mode = MODES[payload[0]];
        if (!mode)
            return;
        this._extras = [payload[1], payload[2], payload[3], payload[4]];
        this.noiseModes = ['off', 'transparency', 'nc'];
        this.noise = {mode, level: null};
        this._noiseConfirmed();
        this._changed();
    }
});

export default {
    id: 'soundcore',
    match: info => info.uuids.find(uuid => uuid.startsWith(UUID_PREFIX)) ?? null,
    Session: SoundcoreSession,
};
