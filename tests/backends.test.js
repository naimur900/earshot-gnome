// SPDX-License-Identifier: GPL-3.0-or-later
/* Framing and parsing tests for every backend, outside the shell:
 * gjs -m tests/backends.test.js
 * Where a vector is published (Gadgetbridge's tests, GalaxyBudsClient's CRC
 * example, LibrePods' documentation), it is used as is. */

import System from 'system';

import {answerChallenge} from '../src/backends/xiaomiAuth.js';
import {
    bmapPacket, parseBmap, parseBoseBattery,
} from '../src/backends/bose.js';
import {
    listeningModePacket, parseAirPodsBattery, parseModelNumber,
} from '../src/backends/apple.js';
import {crc16modbus, encodeNothing, parseNothing} from '../src/backends/nothing.js';
import {crc16xmodem, encodeGalaxy, parseGalaxy} from '../src/backends/samsung.js';
import {
    buildAmbientSet, encodeSony, parseAmbient, parseSony,
} from '../src/backends/sony.js';
import {encodeSoundcore, parseSoundcore} from '../src/backends/soundcore.js';
import {encodeXiaomi, parseXiaomi} from '../src/backends/xiaomi.js';
import {findBackend} from '../src/backends/index.js';

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

const bytes = text => new Uint8Array(text.trim().split(/[\s:]+/).map(b => parseInt(b, 16)));
const hex = array => [...array].map(b => b.toString(16).padStart(2, '0')).join(' ');
const plain = message => Object.fromEntries(Object.entries(message)
    .map(([k, v]) => [k, v instanceof Uint8Array ? hex(v) : v]));

/* Sony: frames from Gadgetbridge's SonyProtocolImplV1Test. */
check('sony frame', hex(encodeSony(0x0c, 1, [0x12, 0x02])), '3e 0c 01 00 00 00 02 12 02 23 3c');
check('sony frame 2', hex(encodeSony(0x0c, 0, [0xfa, 0x03])), '3e 0c 00 00 00 00 02 fa 03 0b 3c');
const escaped = encodeSony(0x0c, 0, [0x3e, 0x3c]);
check('sony escape', hex(escaped).includes('3d 2e 3d 2c'), true);
check('sony round trip', parseSony(escaped)[0].map(plain), [{type: 0x0c, seq: 0, payload: '3e 3c'}]);
check('sony bad checksum dropped', parseSony(bytes('3e 0c 01 00 00 00 02 12 02 24 3c'))[0], []);
check('sony partial waits', hex(parseSony(bytes('00 3e 0c 01'))[1]), '3e 0c 01');

const v1 = {variant: 0x02, wind: false, focus: 0, level: 10};
check('sony v1 set off', hex(buildAmbientSet(1, {...v1, level: 0}, 'off')), '68 02 00 00 00 01 00 00');
check('sony v1 set ambient', hex(buildAmbientSet(1, v1, 'transparency')), '68 02 11 00 00 01 00 0a');
check('sony v1 set nc', hex(buildAmbientSet(1, v1, 'nc')), '68 02 11 00 01 01 00 00');
check('sony v1 set ambient (wind model)', hex(buildAmbientSet(1, {...v1, wind: true}, 'transparency')),
    '68 02 11 02 00 01 00 0a');
check('sony v1 read nc', parseAmbient(1, bytes('67 02 01 00 01 01 00 00')),
    {variant: 2, mode: 'nc', wind: false, focus: 0, level: 0});
check('sony v1 read wind', parseAmbient(1, bytes('67 02 01 02 01 01 00 00'))?.mode, 'wind');
check('sony v2 read ambient', parseAmbient(2, bytes('67 15 01 01 01 00 14')),
    {variant: 0x15, mode: 'transparency', wind: false, focus: 0, level: 20});
check('sony v2 set nc', hex(buildAmbientSet(2, {variant: 0x15, wind: false, focus: 0, level: 20}, 'nc')),
    '68 15 01 01 00 00 14');

/* Galaxy Buds: the CRC example from GalaxyBudsClient's Crc16.cs. */
check('galaxy crc', crc16xmodem([...bytes('61 02 00 4B 5F 01 00 00 00 01 05 00 02 00 13')]), 0xf30f);
check('galaxy frame', hex(encodeGalaxy(false, 0x78, [0x01])).slice(0, 14), 'fd 04 00 78 01');
check('galaxy legacy frame', hex(encodeGalaxy(true, 0x80, [0x01])).slice(0, 14), 'fe 00 04 80 01');
check('galaxy round trip', parseGalaxy(false, encodeGalaxy(false, 0x61, [1, 2, 3]))[0].map(plain),
    [{id: 0x61, payload: '01 02 03'}]);
const corrupt = encodeGalaxy(false, 0x61, [1, 2, 3]);
corrupt[5] ^= 0xff;
check('galaxy bad crc dropped', parseGalaxy(false, corrupt)[0], []);

/* Nothing: CRC-16/MODBUS check value, then a round trip. */
check('modbus check value', crc16modbus([...'123456789'].map(c => c.charCodeAt(0))), 0x4b37);
const battery = encodeNothing(0x5120, 0xc007, [], 0);
check('nothing battery request', hex(battery.slice(0, 8)), '55 20 51 07 c0 00 00 00');
check('nothing round trip', parseNothing(encodeNothing(0x0120, 0x401e, [0x01, 0x05, 0x00], 0))[0]
    .map(plain), [{control: 0x0120, command: 0x401e, payload: '01 05 00'}]);

/* AirPods: packets from LibrePods' AAP Definitions. */
check('airpods battery', parseAirPodsBattery(bytes(
    '04 00 04 00 04 00 03 02 01 64 02 01 04 01 63 01 01 08 01 11 02 01')), {
    right: {level: 100, charging: false},
    left: {level: 99, charging: true},
    case: {level: 17, charging: false},
});
check('airpods disconnected bud', parseAirPodsBattery(bytes('04 00 04 00 04 00 01 04 01 00 04 01')),
    {left: null});
check('airpods set nc', hex(listeningModePacket('nc')), '04 00 04 00 09 00 0d 02 00 00 00');
check('airpods model number', parseModelNumber(bytes(
    '04 00 04 00 1d 00 02 d5 00 04 00 41 69 72 50 6f 64 73 20 50 72 6f 00 41 33 30 34 38 00 41 70 70 6c 65')),
'A3048');

/* Bose: battery records from bosectl's NOTES.md. */
check('bose earbuds battery', parseBoseBattery(bytes('3c ff ff 01 3c ff ff 02 50 ff ff 03 3c ff ff 04')), {
    right: {level: 60, charging: false},
    left: {level: 60, charging: false},
    case: {level: 80, charging: false},
});
check('bose headphones battery', parseBoseBattery(bytes('50 ff ff 00')), {device: {level: 80, charging: false}});
check('bose old battery', parseBoseBattery(bytes('46')), {device: {level: 70, charging: false}});
check('bose packet', hex(bmapPacket([31, 3], 5, [1, 0])), '1f 03 05 02 01 00');
check('bose two replies', parseBmap(bytes('02 02 03 01 50 1f 03 03 01 00'))[0].map(plain), [
    {fblock: 2, func: 2, op: 3, payload: '50'},
    {fblock: 31, func: 3, op: 3, payload: '00'},
]);

/* Xiaomi: frames in Gadgetbridge's layout; the cipher against an
 * independent Python port of the same Java code. */
check('xiaomi request', hex(encodeXiaomi(0xc4, 0x08, 7, [0x02, 0x04, 0x01])),
    'fe dc ba c4 08 00 04 07 02 04 01 ef');
check('xiaomi response', hex(encodeXiaomi(0x04, 0x0e, 9, [])), 'fe dc ba 04 0e 00 02 00 09 ef');
check('xiaomi parse both', parseXiaomi(new Uint8Array([
    ...encodeXiaomi(0x04, 0x02, 3, [0x04, 0x07, 0x50, 0x48, 0xff]),
    ...encodeXiaomi(0xc0, 0x51, 4, [0x01]),
]))[0].map(plain), [
    {type: 0x04, opcode: 0x02, seq: 3, payload: '04 07 50 48 ff'},
    {type: 0xc0, opcode: 0x51, seq: 4, payload: '01'},
]);
const challenges = [0, 1, 2].map(t => Array.from({length: 16}, (_, i) => t * 37 + i * 11 + 5 & 0xff));
check('xiaomi challenge answers', challenges.map(c => hex(answerChallenge(c)).replaceAll(' ', '')), [
    '60580beb46d148c1f976933491cfb5f4',
    '81b3a054e4b99884231b4bc0652c4ea8',
    'bb501d1fd89e0e6ed36b4ccdf7f248e0',
]);

/* Soundcore: the checksum is the low byte of the sum. */
check('soundcore request', hex(encodeSoundcore(0x0101)), '08 ee 00 00 00 01 01 0a 00 02');
check('soundcore battery', parseSoundcore(bytes('09 ff 00 00 01 01 03 0d 00 04 05 02 00'))[0].map(plain),
    [{command: 0x0301, payload: '04 05 02'}]);

/* Which backend takes which device. */
const device = (name, uuids, vendor = null) => ({name, uuids, vendor, product: null});
const pick = info => findBackend(info)?.backend.id ?? null;
check('pick realme', pick(device('realme Buds T500 Pro',
    ['0000079a-d102-11e1-9b23-00025b00a5a5', '00001101-0000-1000-8000-00805f9b34fb'])), 'oppo');
check('pick redmi', pick(device('Redmi Buds 5',
    ['0000fd2d-0000-1000-8000-00805f9b34fb', '00001101-0000-1000-8000-00805f9b34fb'])), 'xiaomi');
check('pick galaxy buds pro', pick(device('Galaxy Buds Pro (A1B2)',
    ['00001101-0000-1000-8000-00805f9b34fb'], 0x0075)), 'samsung');
check('pick sony', pick(device('WH-1000XM5', ['956c7b26-d49a-4ba8-b03f-b17d393cb6e2'])), 'sony');
check('pick airpods', pick(device('AirPods Pro', ['74ec2172-0bad-4d01-8f77-997b2be0722a'])), 'apple');
check('pick soundcore', pick(device('soundcore Liberty 4 NC',
    ['0cf12d31-fac3-4553-bd80-d6832e7b3947'])), 'soundcore');
check('generic serial port is nobody\'s', pick(device('QCY T13',
    ['00001101-0000-1000-8000-00805f9b34fb'])), null);

if (failures > 0) {
    print(`\n${failures} failed`);
    System.exit(1);
}
print('\nall passed');
