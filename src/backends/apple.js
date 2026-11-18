// SPDX-License-Identifier: GPL-3.0-or-later
/* backends/apple.js: AirPods and the Beats that speak the same protocol,
 * Apple's AAP over an L2CAP channel. Battery of each bud and the case (or of
 * AirPods Max), and listening modes: off, transparency, noise cancellation,
 * and adaptive on the models that have it.
 *
 * Each packet arrives as one L2CAP packet; there is no framing to undo.
 * After a handshake and a request for notifications the AirPods report their
 * battery, listening mode and model. Follows LibrePods' documentation. */

import GObject from 'gi://GObject';

import {ChannelSession} from '../session.js';

const AAP_UUID = '74ec2172-0bad-4d01-8f77-997b2be0722a';

const HANDSHAKE = [0x00, 0x00, 0x04, 0x00, 0x01, 0x00, 0x02, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
/* Turns on the features Apple keeps for its own devices; without it the
 * AirPods Pro 2 refuse Adaptive. */
const ENABLE_FEATURES = [0x04, 0x00, 0x04, 0x00, 0x4d, 0x00, 0xff, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
const REQUEST_NOTIFICATIONS = [0x04, 0x00, 0x04, 0x00, 0x0f, 0x00, 0xff, 0xff, 0xfe, 0xff];

const HEADER = [0x04, 0x00, 0x04, 0x00];
const OP_BATTERY = 0x04;
const OP_EAR = 0x06;
const OP_CONTROL = 0x09;
const OP_METADATA = 0x1d;
const CONTROL_LISTENING_MODE = 0x0d;

const MODE_VALUES = {off: 0x01, nc: 0x02, transparency: 0x03, adaptive: 0x04};
const MODE_NAMES = {0x01: 'off', 0x02: 'nc', 0x03: 'transparency', 0x04: 'adaptive'};

const COMPONENTS = {0x01: 'device', 0x02: 'right', 0x04: 'left', 0x08: 'case'};
const STATUS_CHARGING = 0x01;
const STATUS_DISCONNECTED = 0x04;

/* Model numbers (from Apple's support pages) of the models with noise
 * control, and those with Adaptive among them. */
const ANC_MODELS = new Set([
    'A2084', 'A2083', 'A2096', 'A3184', 'A3047', 'A3048', 'A3049',
    'A2931', 'A2699', 'A2698', 'A3056', 'A3055', 'A3057',
]);
const ADAPTIVE_MODELS = new Set([
    'A3047', 'A3048', 'A3049', 'A2931', 'A2699', 'A2698', 'A3056', 'A3055', 'A3057',
]);

export function listeningModePacket(mode) {
    return [...HEADER, OP_CONTROL, 0x00, CONTROL_LISTENING_MODE, MODE_VALUES[mode], 0x00, 0x00, 0x00];
}

/* {left, right, case, device} from a battery notification, or null. */
export function parseAirPodsBattery(packet) {
    const count = packet[6];
    if (packet.length < 7 + count * 5)
        return null;
    const battery = {};
    for (let i = 0; i < count; i++) {
        const at = 7 + i * 5;
        const part = COMPONENTS[packet[at]];
        if (!part)
            continue;
        const value = packet[at + 2];
        const status = packet[at + 3];
        battery[part] = status === STATUS_DISCONNECTED || value > 100
            ? null : {level: value, charging: status === STATUS_CHARGING};
    }
    return battery;
}

/* The model number ("A2084") among a metadata packet's strings, or null. */
export function parseModelNumber(packet) {
    const text = String.fromCharCode(...packet.slice(5).map(b => b >= 0x20 && b < 0x7f ? b : 0));
    return text.split('\0').find(part => /^A\d{4}$/.test(part)) ?? null;
}

function startsWith(packet, prefix) {
    return prefix.every((byte, i) => packet[i] === byte);
}

const AirPodsSession = GObject.registerClass(
class AirPodsSession extends ChannelSession {
    _init(fd, info) {
        super._init(fd, info);
        this.sendGapMs = 100;
        this._model = null;
        this._reportsModes = false;
        this._reportsAdaptive = false;
    }

    _start() {
        this._send(HANDSHAKE);
        this._send(ENABLE_FEATURES);
        this._send(REQUEST_NOTIFICATIONS);
    }

    /* The request for notifications makes them report their state again. */
    refresh() {
        this._send(REQUEST_NOTIFICATIONS);
    }

    setNoise(mode) {
        if (!this.noiseModes.includes(mode))
            return;
        this._send(listeningModePacket(mode));
        this._expectNoise({mode, level: null}, () => this.refresh());
    }

    /* L2CAP keeps packets apart: each read is one. */
    _onBytes(bytes) {
        const packet = Uint8Array.from(bytes);
        if (!startsWith(packet, HEADER) || packet.length < 6)
            return;

        switch (packet[4]) {
        case OP_BATTERY: {
            const battery = parseAirPodsBattery(packet);
            if (battery) {
                this.battery = {...this.battery, ...battery};
                this._changed();
            }
            break;
        }
        case OP_EAR:
            if (packet.length >= 8) {
                /* 0 is in an ear; which bud is primary is not said. */
                const worn = packet[6] === 0 || packet[7] === 0;
                this.wear = {left: worn, right: worn};
                this._changed();
            }
            break;
        case OP_CONTROL:
            if (packet[6] === CONTROL_LISTENING_MODE && packet.length >= 8)
                this._onListeningMode(MODE_NAMES[packet[7]]);
            break;
        case OP_METADATA:
            this._model = parseModelNumber(packet);
            this._updateModes();
            break;
        }
    }

    _onListeningMode(mode) {
        if (!mode)
            return;
        /* A model that reports a mode has listening modes, whatever its
         * model number. */
        this._reportsModes = true;
        if (mode === 'adaptive')
            this._reportsAdaptive = true;
        this.noise = {mode, level: null};
        this._noiseConfirmed();
        this._updateModes();
    }

    _updateModes() {
        const known = this._model && ANC_MODELS.has(this._model);
        if (!this._reportsModes && !known)
            return;
        const adaptive = this._reportsAdaptive ||
            (this._model && ADAPTIVE_MODELS.has(this._model));
        this.noiseModes = ['off', 'transparency', 'nc', ...adaptive ? ['adaptive'] : []];
        this._changed();
    }
});

export default {
    id: 'apple',
    match(info) {
        if (info.uuids.includes(AAP_UUID))
            return AAP_UUID;
        return null;
    },
    Session: AirPodsSession,
};
