// SPDX-License-Identifier: GPL-3.0-or-later
/* noise.js: the noise control vocabulary every backend reports in, so the
 * menu needs to know no brand's own names.
 *
 * Modes, in the order the switcher shows them:
 *   off           no noise control
 *   transparency  outside sound let in (Ambient, Aware, Transparency)
 *   nc            active noise cancelling, at a level where there are levels
 *   adaptive      the buds choose between cancelling and letting sound in
 *   wind          noise cancelling that also cuts wind noise (Sony, Bose)
 *   immersion     Bose's cancelling with spatial audio that follows the head
 *   cinema        Bose's cancelling with fixed spatial audio
 *
 * Levels of 'nc', weakest first: light, medium, deep, smart (the buds pick). */

export const NOISE_MODES = ['off', 'transparency', 'nc', 'adaptive', 'wind', 'immersion', 'cinema'];
export const NOISE_LEVELS = ['light', 'medium', 'deep', 'smart'];

const CANCELLING = new Set(['nc', 'adaptive', 'wind', 'immersion', 'cinema']);

/* Whether a mode keeps outside noise out: the tile is lit for these. */
export function isCancelling(mode) {
    return CANCELLING.has(mode);
}

/* `modes` in display order, without duplicates or unknown names. */
export function orderModes(modes) {
    return NOISE_MODES.filter(mode => modes.includes(mode));
}

export function orderLevels(levels) {
    return NOISE_LEVELS.filter(level => levels.includes(level));
}
