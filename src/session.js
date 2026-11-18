// SPDX-License-Identifier: GPL-3.0-or-later
/* session.js: one open control channel to a pair of headphones, whatever
 * their brand. It owns the socket BlueZ handed over, queues what is written
 * to it and hands what is read to the brand's backend, a subclass, which
 * keeps the state below up to date and emits 'changed'.
 *
 * State, as every backend reports it:
 *   battery      {left, right, case, device}: each {level, charging}, or null
 *                for a part that is there but whose level is not known. A part
 *                the headphones never mention is left out. 'device' is the one
 *                level of headphones that report no parts.
 *   noiseModes   the modes from noise.js the headphones can be set to; empty
 *                without noise control.
 *   noiseLevels  the levels of 'nc' they can be set to; empty without.
 *   noise        {mode, level}, or null until they say.
 *   wear         {left, right}: true for a bud in an ear, or null.
 *   refused      the headphones turned down the last mode change.
 *   devices      the devices the headphones are linked with, this computer
 *                among them, where they say: [{address, name, connected,
 *                self, playing, pending}], or null.
 *   canManageDevices  whether connectDevice() and disconnectDevice() work. */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const READ_SIZE = 4096;
/* Bytes kept while waiting for the rest of a frame; more is noise. */
const MAX_PENDING = 16384;
/* How long a reply may take before the next command goes anyway. */
const ACK_TIMEOUT_MS = 1500;
/* How long a mode change may go unreported before it is read back. */
const VERIFY_MS = 1500;

export const ChannelSession = GObject.registerClass({
    Signals: {
        'changed': {},
        'closed': {},
    },
}, class ChannelSession extends GObject.Object {
    /* Takes ownership of `fd`, a connected socket; throws if it is not one,
     * and then the fd is still the caller's. `info` is what BlueZ says about
     * the device (see bluez.js). Nothing is read or sent until start(). */
    _init(fd, info) {
        super._init();

        this.info = info;
        this.battery = {};
        this.noiseModes = [];
        this.noiseLevels = [];
        this.noise = null;
        this.wear = null;
        this.refused = false;
        this.devices = null;
        this.canManageDevices = false;

        /* Subclasses may change these in their _init(). */
        this.sendGapMs = 120;

        this._queue = [];
        this._writing = false;
        this._awaitingAck = false;
        this._gapId = 0;
        this._ackId = 0;
        this._verifyId = 0;
        this._laterIds = new Set();
        this._closed = false;
        this._pending = new Uint8Array(0);
        this._cancellable = new Gio.Cancellable();

        const socket = Gio.Socket.new_from_fd(fd);
        this._connection = socket.connection_factory_create_connection();
        this._input = this._connection.get_input_stream();
        this._output = this._connection.get_output_stream();
    }

    get closed() {
        return this._closed;
    }

    start() {
        this._read();
        this._start();
    }

    /* Reads everything again: not every model pushes every change. */
    refresh() {
    }

    /* Sets a mode from noiseModes; for 'nc', `level` from noiseLevels or
     * null for the one in use. */
    setNoise(_mode, _level) {
    }

    /* Asks the headphones to link with, or drop, another device of theirs,
     * by its address as `devices` gives it. */
    connectDevice(_address) {
    }

    disconnectDevice(_address) {
    }

    /* For subclasses. */

    /* Runs `callback` once after `ms`, unless the session closes first. */
    _later(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._laterIds.delete(id);
            if (!this._closed)
                callback();
            return GLib.SOURCE_REMOVE;
        });
        this._laterIds.add(id);
    }

    /* Sends the first commands once the socket is read. */
    _start() {
    }

    /* Whole frames from `buffer`, a Uint8Array of everything not yet used:
     * handles them and returns what is left, a partial frame. */
    _parse(_buffer) {
        return new Uint8Array(0);
    }

    /* Queues a frame. `waitAck`: nothing else is sent until _acked() or a
     * timeout, for protocols that take one command at a time. `urgent`: ahead
     * of the queue and of any wait, for acknowledging the headphones. */
    _send(bytes, {waitAck = false, urgent = false} = {}) {
        if (this._closed)
            return;
        const item = {bytes: Uint8Array.from(bytes), waitAck, urgent};
        if (urgent)
            this._queue.unshift(item);
        else
            this._queue.push(item);
        this._pump();
    }

    _acked() {
        if (!this._awaitingAck)
            return;
        this._awaitingAck = false;
        this._clearSource('_ackId');
        this._pump();
    }

    /* Shows a mode at once; if the headphones neither confirm nor correct it
     * within VERIFY_MS, `readBack` asks them. */
    _expectNoise(state, readBack) {
        this.refused = false;
        this.noise = state;
        this._changed();
        this._clearSource('_verifyId');
        this._verifyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VERIFY_MS, () => {
            this._verifyId = 0;
            readBack();
            return GLib.SOURCE_REMOVE;
        });
    }

    /* The headphones reported their mode: no read-back needed. */
    _noiseConfirmed() {
        this._clearSource('_verifyId');
    }

    _changed() {
        if (!this._closed)
            this.emit('changed');
    }

    /* Internals. */

    _pump() {
        if (this._closed || this._writing || this._gapId || this._queue.length === 0)
            return;
        if (this._awaitingAck && !this._queue[0].urgent)
            return;

        const item = this._queue.shift();
        this._writing = true;
        this._output.write_bytes_async(new GLib.Bytes(item.bytes), GLib.PRIORITY_DEFAULT,
            this._cancellable, (stream, result) => {
                this._writing = false;
                let written;
                try {
                    written = stream.write_bytes_finish(result);
                } catch (e) {
                    this._fail(e);
                    return;
                }
                if (this._closed)
                    return;
                if (written < item.bytes.length) {
                    this._queue.unshift({...item, bytes: item.bytes.slice(written)});
                } else if (item.waitAck) {
                    this._awaitingAck = true;
                    this._clearSource('_ackId');
                    this._ackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ACK_TIMEOUT_MS, () => {
                        this._ackId = 0;
                        this._acked();
                        return GLib.SOURCE_REMOVE;
                    });
                }

                this._gapId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.sendGapMs, () => {
                    this._gapId = 0;
                    this._pump();
                    return GLib.SOURCE_REMOVE;
                });
            });
    }

    _read() {
        this._input.read_bytes_async(READ_SIZE, GLib.PRIORITY_DEFAULT, this._cancellable,
            (stream, result) => {
                let bytes;
                try {
                    bytes = stream.read_bytes_finish(result).toArray();
                } catch (e) {
                    this._fail(e);
                    return;
                }
                if (this._closed)
                    return;
                if (bytes.length === 0) {
                    this._fail(null);
                    return;
                }
                this._onBytes(bytes);
                this._read();
            });
    }

    /* Stream sockets: frames can split across reads or share one. */
    _onBytes(bytes) {
        const buffer = new Uint8Array(this._pending.length + bytes.length);
        buffer.set(this._pending);
        buffer.set(bytes, this._pending.length);

        let rest;
        try {
            rest = this._parse(buffer);
        } catch (e) {
            console.warn(`Earshot: unreadable frame: ${e.message}`);
            rest = new Uint8Array(0);
        }
        this._pending = rest.length > MAX_PENDING ? new Uint8Array(0) : rest;
    }

    _clearSource(field) {
        if (this[field]) {
            GLib.source_remove(this[field]);
            this[field] = 0;
        }
    }

    _fail(error) {
        if (this._closed)
            return;
        if (error && !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            console.debug(`Earshot: control channel closed: ${error.message}`);
        this.destroy();
        this.emit('closed');
    }

    destroy() {
        if (this._closed)
            return;
        this._closed = true;
        this._cancellable.cancel();
        for (const field of ['_gapId', '_ackId', '_verifyId'])
            this._clearSource(field);
        for (const id of this._laterIds)
            GLib.source_remove(id);
        this._laterIds.clear();
        this._queue = [];
        try {
            this._connection.close(null);
        } catch {
            /* Already gone with the link. */
        }
    }
});

/* Helpers shared by the backends. */

export function concatBytes(...parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/* Index of `needle` (an array of bytes) in `haystack` from `from`, or -1. */
export function indexOfBytes(haystack, needle, from = 0) {
    outer:
    for (let i = from; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j])
                continue outer;
        }
        return i;
    }
    return -1;
}

/* A battery level from a byte where 0 or 0xff means not known. */
export function level(value, {max = 100, charging = false} = {}) {
    if (value === undefined || value === 0xff || value <= 0 || value > max)
        return null;
    return {level: Math.round(value * 100 / max), charging};
}
