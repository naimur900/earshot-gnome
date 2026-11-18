// SPDX-License-Identifier: GPL-3.0-or-later
/* Protocol tests, outside the shell: gjs -m tests/oppo.test.js
 * The frames are real ones, captured from a realme Buds T500 Pro. */

import System from 'system';

import {
    NoiseTable, bitmapHas, encodeFrame, manageDevicePayload, parseBattery, parseDevices,
    parseFrames, parseNoiseBits, parseWear,
} from '../src/backends/oppo.js';

let failures = 0;

function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        print(`ok   ${name}`);
    } else {
        failures++;
        print(`FAIL ${name}\n     got      ${a}\n     expected ${e}`);
    }
}

const bytes = hex => new Uint8Array(hex.trim().split(/\s+/).map(b => parseInt(b, 16)));
const hex = array => [...array].map(b => b.toString(16).padStart(2, '0')).join(' ');
const plain = ({cmd, seq, payload}) => ({cmd, seq, payload: hex(payload)});

/* Encoding, against what the vendor app sends. */
check('encode handshake', hex(encodeFrame(0x0100, 0)), 'aa 07 00 00 00 01 00 00 00');
check('encode noise query', hex(encodeFrame(0x010c, 5, [1, 1])),
    'aa 09 00 00 0c 01 05 02 00 01 01');
check('encode set transparency', hex(encodeFrame(0x0404, 7, [1, 1, 2])),
    'aa 0a 00 00 04 04 07 03 00 01 01 02');

/* Two frames in one read: the battery and wear pushes that follow connecting. */
const [pushes, rest] = parseFrames(bytes(`
    aa 0f 00 00 04 02 13 08 00 01 03 01 64 02 64 03 00
    aa 0f 00 00 04 02 14 08 00 02 03 01 03 02 03 03 04`));
check('two frames', pushes.map(plain), [
    {cmd: 0x0204, seq: 0x13, payload: '01 03 01 64 02 64 03 00'},
    {cmd: 0x0204, seq: 0x14, payload: '02 03 01 03 02 03 03 04'},
]);
check('nothing left over', rest.length, 0);

/* A frame split across reads waits for its end; noise before it is dropped. */
const reply = bytes('aa 0f 00 00 06 81 04 08 00 00 03 01 64 02 64 03 00');
const [none, pending] = parseFrames(new Uint8Array([0x13, 0x37, ...reply.slice(0, 10)]));
check('partial frame waits', [none.length, hex(pending)], [0, hex(reply.slice(0, 10))]);
const [whole] = parseFrames(new Uint8Array([...pending, ...reply.slice(10)]));
check('partial frame completes', whole.map(plain),
    [{cmd: 0x8106, seq: 4, payload: '00 03 01 64 02 64 03 00'}]);

/* A slice of a long message is skipped whole, and what follows still reads. */
const [afterSlice] = parseFrames(bytes(`
    aa 06 01 00 00 05 81 06
    aa 08 00 00 04 84 07 01 00 00`));
check('slice skipped', afterSlice.map(plain), [{cmd: 0x8404, seq: 7, payload: '00'}]);

/* Battery: the closed case reports level 0, not known; the top bit is charging. */
check('battery reply', parseBattery(bytes('00 03 01 64 02 64 03 00'), 1), {
    left: {level: 100, charging: false},
    right: {level: 100, charging: false},
    case: null,
});
check('battery charging', parseBattery(bytes('01 03 01 d5 02 50 03 3e'), 1), {
    left: {level: 85, charging: true},
    right: {level: 80, charging: false},
    case: {level: 62, charging: false},
});
check('battery truncated', parseBattery(bytes('01 03 01 50 02'), 1),
    {left: {level: 80, charging: false}});

/* Wear: 3 is out of the case and in an ear, 1 out but not worn, 4 in the case. */
check('wear push, worn', parseWear(bytes('02 03 01 03 02 03 03 04'), 1),
    {left: true, right: true});
check('wear push, taken out', parseWear(bytes('02 03 01 01 02 01 03 04'), 1),
    {left: false, right: false});
check('wear reply with status', parseWear(bytes('00 02 01 07 02 04'), 1),
    {left: true, right: false});
check('not a wear list', parseWear(bytes('00 09 01'), 1), null);

/* Noise reports: the query reply and the push. */
check('noise reply', parseNoiseBits(bytes('00 01 01 01'), 1), 0x01);
check('noise push', parseNoiseBits(bytes('03 01 01 02'), 1), 0x02);
check('noise wide bits', parseNoiseBits(bytes('00 01 01 00 08'), 1), 0x0800);
check('not a mode report', parseNoiseBits(bytes('03 02 01 07 08'), 1), 0);

/* The T500 Pro's table, picked by product id 0x066452. */
const t500 = NoiseTable.forProduct(0x066452, 'realme Buds T500 Pro');
check('t500 modes', t500.modes, ['off', 'transparency', 'nc']);
check('t500 levels', t500.levels, ['light', 'medium', 'deep', 'smart']);
check('t500 set bits', ['off', 'transparency'].map(m => t500.bitFor(m)), [0, 1]);
check('t500 nc levels', ['light', 'medium', 'deep', 'smart'].map(l => t500.bitFor('nc', l)),
    [2, 4, 3, 5]);
check('t500 nc default', [t500.defaultLevel, t500.bitFor('nc')], ['deep', 3]);
check('t500 reads', [0x01, 0x02, 0x08, 0x20, 0x40].map(bits => t500.read(bits)), [
    {mode: 'off', level: null},
    {mode: 'transparency', level: null},
    {mode: 'nc', level: 'deep'},
    {mode: 'nc', level: 'smart'},
    null,
]);

/* OnePlus Buds 4: Off is set as bit 0 but reported as bit 3, Adaptive is bit 11. */
const buds4 = NoiseTable.forProduct(0x065414, 'OnePlus Buds 4');
check('buds4 modes', buds4.modes, ['off', 'transparency', 'nc', 'adaptive']);
check('buds4 bits', [buds4.bitFor('off'), buds4.bitFor('adaptive'), buds4.bitFor('nc', 'deep')],
    [0, 11, 4]);
check('buds4 reads off as bit 3', buds4.read(0x08), {mode: 'off', level: null});

/* A renamed device is still found by its id; an unknown model has no table. */
check('found by id', NoiseTable.forProduct(0x066452, 'My buds')?.modes.length, 3);
check('unknown model', NoiseTable.forProduct(0x123456, 'Some buds'), null);

/* The T500 Pro's command bitmap, from its handshake reply: the device list
 * (bit 29) but no connecting or disconnecting (bit 59). */
const t500Bitmap = [...bytes('bf 0f 5a e6 65 dc 40 04')];
check('t500 lists devices', bitmapHas(t500Bitmap, 29), true);
check('t500 cannot manage devices', bitmapHas(t500Bitmap, 59), false);
check('t500 sets noise', bitmapHas(t500Bitmap, 8), true);
check('bit past the bitmap is off', bitmapHas(t500Bitmap, 68), false);

/* A device list in the layout QuickBuds captured: MACs reversed, then
 * <len> <state> <flags> <nameLen> <name>. */
const name = text => [...text].map(c => c.charCodeAt(0));
const entry = (mac, state, flags, label) =>
    [...mac.split(':').reverse().map(h => parseInt(h, 16)), 3 + label.length, state, flags, label.length, ...name(label)];
const list = new Uint8Array([0x00, 3,
    ...entry('AA:BB:CC:DD:EE:01', 2, 0x01, 'naimur-pc'),
    ...entry('11:22:33:44:55:66', 2, 0x04, 'Pixel 8'),
    ...entry('77:88:99:AA:BB:CC', 0, 0x00, 'iPad')]);
check('device list', parseDevices(list, 1), [
    {address: 'AA:BB:CC:DD:EE:01', name: 'naimur-pc', connected: true, self: true, playing: false},
    {address: '11:22:33:44:55:66', name: 'Pixel 8', connected: true, self: false, playing: true},
    {address: '77:88:99:AA:BB:CC', name: 'iPad', connected: false, self: false, playing: false},
]);
check('this computer by address', parseDevices(new Uint8Array([0x00, 1,
    ...entry('AA:BB:CC:DD:EE:02', 2, 0x00, 'pc')]), 1, ['AA:BB:CC:DD:EE:02'])[0].self, true);
check('cut short list', parseDevices(list.slice(0, 20), 1), null);
check('NUL-terminated name, as the T500 Pro sends it', parseDevices(new Uint8Array([0x00, 1,
    ...entry('98:AF:65:38:CF:E7', 2, 0x01, 'fedora\0')]), 1)[0].name, 'fedora');
check('disconnect payload', hex(manageDevicePayload(false, '11:22:33:44:55:66')), '02 11 22 33 44 55 66');
check('connect payload', hex(manageDevicePayload(true, '77:88:99:AA:BB:CC')), '01 77 88 99 aa bb cc');

if (failures > 0) {
    print(`\n${failures} failed`);
    System.exit(1);
}
print('\nall passed');
