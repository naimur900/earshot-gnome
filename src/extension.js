// SPDX-License-Identifier: GPL-3.0-or-later
/* extension.js: adds the headphones' tile to the quick settings while
 * enabled. */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {HeadphoneManager} from './headphones.js';
import {HeadphoneIndicator} from './quickToggle.js';

export default class EarshotExtension extends Extension {
    enable() {
        this._manager = new HeadphoneManager();
        this._indicator = new HeadphoneIndicator(this._manager);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        /* The tile first: it listens to the manager. Destroying the manager
         * closes every control channel and unregisters the profile. */
        this._indicator?.destroy();
        this._indicator = null;

        this._manager?.destroy();
        this._manager = null;
    }
}
