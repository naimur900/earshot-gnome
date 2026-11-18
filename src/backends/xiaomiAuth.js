// SPDX-License-Identifier: GPL-3.0-or-later
/* backends/xiaomiAuth.js: the answer to a Xiaomi earbuds' authentication
 * challenge. A SAFER+-style block cipher keyed with the challenge encrypts a
 * fixed block; ported from Gadgetbridge's Redmi Buds 5 Pro support. All
 * arithmetic is on bytes, wrapping at 256. */

const BLOCK = 16;
/* Bytes 0, 3, 4, 7, 8, 11, 12 and 15 use XOR and exp; the rest add and log. */
const PATTERN = 0x9999;

const SEQ = [0x11, 0x22, 0x33, 0x33, 0x22, 0x11, 0x11, 0x22,
    0x33, 0x33, 0x22, 0x11, 0x11, 0x22, 0x33, 0x33];

const COEFFICIENTS = [
    [2, 1, 1, 1, 4, 2, 1, 1, 2, 2, 4, 2, 4, 4, 16, 8],
    [2, 1, 1, 1, 4, 2, 1, 1, 1, 1, 2, 1, 2, 2, 8, 4],
    [1, 1, 4, 2, 2, 2, 4, 2, 16, 8, 4, 4, 2, 1, 1, 1],
    [1, 1, 4, 2, 1, 1, 2, 1, 8, 4, 2, 2, 2, 1, 1, 1],
    [16, 8, 2, 2, 4, 2, 4, 4, 1, 1, 4, 2, 1, 1, 2, 1],
    [8, 4, 1, 1, 2, 1, 2, 2, 1, 1, 4, 2, 1, 1, 2, 1],
    [2, 2, 4, 2, 4, 4, 16, 8, 2, 1, 1, 1, 4, 2, 1, 1],
    [1, 1, 2, 1, 2, 2, 8, 4, 2, 1, 1, 1, 4, 2, 1, 1],
    [4, 2, 4, 4, 16, 8, 2, 2, 1, 1, 2, 1, 1, 1, 4, 2],
    [2, 1, 2, 2, 8, 4, 1, 1, 1, 1, 2, 1, 1, 1, 4, 2],
    [4, 4, 16, 8, 1, 1, 2, 1, 4, 2, 1, 1, 4, 2, 2, 2],
    [2, 2, 8, 4, 1, 1, 2, 1, 4, 2, 1, 1, 2, 1, 1, 1],
    [1, 1, 2, 1, 1, 1, 4, 2, 4, 4, 16, 8, 2, 2, 4, 2],
    [1, 1, 2, 1, 1, 1, 4, 2, 2, 2, 8, 4, 1, 1, 2, 1],
    [4, 2, 1, 1, 2, 1, 1, 1, 4, 2, 2, 2, 16, 8, 4, 4],
    [4, 2, 1, 1, 2, 1, 1, 1, 2, 1, 1, 1, 8, 4, 2, 2],
];

function modPow(base, exponent, modulus) {
    let result = 1;
    base %= modulus;
    while (exponent > 0) {
        if (exponent & 1)
            result = result * base % modulus;
        base = base * base % modulus;
        exponent >>= 1;
    }
    return result;
}

/* exp: 45^i mod 257, 256 standing for 0; log: its inverse. */
const EXP = Array.from({length: 256}, (_, i) => i === 128 ? 0 : modPow(45, i, 257));
const LOG = new Array(256).fill(0);
LOG[0] = 128;
for (let i = 1; i < 256; i++) {
    const value = modPow(45, i, 257);
    if (value !== 256)
        LOG[value] = i;
}

const BIAS = Array.from({length: 16}, (_, i) => Array.from({length: 16}, (_unused, j) => {
    const value = modPow(45, modPow(45, 17 * (i + 2) + j + 1, 257), 257);
    return value === 256 ? 0 : value;
}));

const usesXor = i => (1 << i & PATTERN) !== 0;

function keySchedule(challenge) {
    const key = [...challenge];
    key[15] ^= 6;
    const keys = [key];
    const register = [...key, key.reduce((x, b) => x ^ b, 0)];
    for (let k = 1; k <= 16; k++) {
        for (let i = 0; i < 17; i++)
            register[i] = (register[i] >>> 5 | register[i] << 3) & 0xff;
        keys.push(Array.from({length: BLOCK}, (_, i) =>
            register[(k + i) % 17] + BIAS[k - 1][i] & 0xff));
    }
    return keys;
}

function encrypt(plaintext, keys) {
    let block = [...plaintext];
    for (let round = 0; round < 8; round++) {
        if (round === 2) {
            block = block.map((b, i) => usesXor(i)
                ? b ^ plaintext[i] : b + plaintext[i] & 0xff);
        }
        block = block.map((b, i) => usesXor(i)
            ? b ^ keys[round * 2][i] : b + keys[round * 2][i] & 0xff);
        block = block.map((b, i) => usesXor(i) ? EXP[b] : LOG[b]);
        block = block.map((b, i) => usesXor(i)
            ? b + keys[round * 2 + 1][i] & 0xff : b ^ keys[round * 2 + 1][i]);
        const mixed = block;
        block = COEFFICIENTS.map(row =>
            row.reduce((sum, c, j) => sum + (c * mixed[j] & 0xff) & 0xff, 0));
    }
    return block.map((b, i) => usesXor(i) ? b ^ keys[16][i] : b + keys[16][i] & 0xff);
}

/* The 16-byte answer to a 16-byte challenge. */
export function answerChallenge(challenge) {
    return encrypt(SEQ, keySchedule(challenge));
}
