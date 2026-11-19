// SPDX-License-Identifier: GPL-3.0-or-later
/* The maker and model the menu's header shows, from a device's names:
 * gjs -m tests/brands.test.js */

import System from 'system';

import {identify} from '../src/brands.js';

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

const id = (name, alias = '', backend = null) => identify({name, alias, backend});

/* The maker first in the name. */
check('realme', id('realme Buds T500 Pro'), {brand: 'realme', model: 'Buds T500 Pro'});
check('OnePlus', id('OnePlus Buds 3'), {brand: 'OnePlus', model: 'Buds 3'});
check('case as the maker writes it', id('REALME Buds Air 5'), {brand: 'realme', model: 'Buds Air 5'});
check('hyphen after the maker', id('JBL-Tune 230NC'), {brand: 'JBL', model: 'Tune 230NC'});
check('QCY', id('QCY T13'), {brand: 'QCY', model: 'T13'});
check('a word that only starts like one', id('Sonya Pods'), {brand: null, model: 'Sonya Pods'});
check('the maker alone', id('JBL'), {brand: null, model: 'JBL'});

/* Product lines without their maker. */
check('AirPods', id('AirPods Pro'), {brand: 'Apple', model: 'AirPods Pro'});
check('Galaxy Buds', id('Galaxy Buds2 Pro'), {brand: 'Samsung', model: 'Galaxy Buds2 Pro'});
check('Sony WH', id('WH-1000XM5'), {brand: 'Sony', model: 'WH-1000XM5'});
check('Bose QC', id('QC35 II'), {brand: 'Bose', model: 'QC35 II'});
check('QCY is not a QC', id('QCYT13'), {brand: null, model: 'QCYT13'});
check('Nothing Ear', id('Ear (2)'), {brand: 'Nothing', model: 'Ear (2)'});

/* From the backend, and through a rename. */
check('backend', id('Liberty 4 NC', '', 'soundcore'), {brand: 'Soundcore', model: 'Liberty 4 NC'});
check('OPPO protocol names no maker', id('Buds X', '', 'oppo'), {brand: null, model: 'Buds X'});
check('renamed', id('realme Buds T500 Pro', 'My buds'), {brand: 'realme', model: 'My buds'});
check('renamed with the maker', id('realme Buds T500 Pro', 'realme Gym'), {brand: 'realme', model: 'Gym'});
check('nameless', id(''), {brand: null, model: ''});

if (failures > 0) {
    print(`\n${failures} failed`);
    System.exit(1);
}
print('\nall passed');
