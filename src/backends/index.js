// SPDX-License-Identifier: GPL-3.0-or-later
/* backends/index.js: the brands whose control protocol the extension speaks.
 * Each backend knows its headphones by the services they offer (and, where
 * that is not enough, their name or maker) and names the service to open:
 *
 *   id         a short name, for the profile's D-Bus path
 *   match()    from what BlueZ says about a device (bluez.js), the UUID of
 *              its control service, or null when it is not this brand's
 *   Session    its ChannelSession subclass (session.js)
 *
 * Headphones no backend takes still show the battery level BlueZ has. */

import apple from './apple.js';
import bose from './bose.js';
import nothing from './nothing.js';
import oppo from './oppo.js';
import samsung from './samsung.js';
import sony from './sony.js';
import soundcore from './soundcore.js';
import xiaomi from './xiaomi.js';

/* First match wins: the ones known by a service of their own come before
 * Samsung's, which can match on the generic serial port. */
const BACKENDS = [oppo, sony, apple, bose, nothing, xiaomi, soundcore, samsung];

/* {backend, uuid} for the device, or null. */
export function findBackend(info) {
    for (const backend of BACKENDS) {
        const uuid = backend.match(info);
        if (uuid)
            return {backend, uuid};
    }
    return null;
}
