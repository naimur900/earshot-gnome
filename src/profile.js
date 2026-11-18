// SPDX-License-Identifier: GPL-3.0-or-later
/* profile.js: a client profile registered with BlueZ for a vendor's serial
 * port service. Device1.ConnectProfile() then opens the RFCOMM channel and
 * BlueZ hands the socket to NewConnection(), with no privileges and no
 * channel number to look up. */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {isDBusError} from './bluez.js';

const PROFILE_MANAGER_PATH = '/org/bluez';
const PROFILE_MANAGER_IFACE = 'org.bluez.ProfileManager1';

const ProfileIface = `
<node>
  <interface name="org.bluez.Profile1">
    <method name="Release"/>
    <method name="NewConnection">
      <arg type="o" direction="in" name="device"/>
      <arg type="h" direction="in" name="fd"/>
      <arg type="a{sv}" direction="in" name="properties"/>
    </method>
    <method name="RequestDisconnection">
      <arg type="o" direction="in" name="device"/>
    </method>
  </interface>
</node>`;

export class VendorProfile {
    /* `onConnection(devicePath, fd)` returns true when it takes the fd;
     * `onDisconnection(devicePath)` closes that device's channel. */
    constructor(bluez, objectPath, uuid, name, {onConnection, onDisconnection}) {
        this._bluez = bluez;
        this._path = objectPath;
        this._uuid = uuid;
        this._name = name;
        this._onConnection = onConnection;
        this._onDisconnection = onDisconnection;
        this._registration = null;

        this._exported = Gio.DBusExportedObject.wrapJSObject(ProfileIface, this);
        this._exported.export(Gio.DBus.system, objectPath);
    }

    get uuid() {
        return this._uuid;
    }

    /* Resolves once BlueZ has the profile. */
    register() {
        this._registration ??= this._bluez.call(PROFILE_MANAGER_PATH,
            PROFILE_MANAGER_IFACE, 'RegisterProfile',
            new GLib.Variant('(osa{sv})', [this._path, this._uuid, {
                Name: new GLib.Variant('s', this._name),
                Role: new GLib.Variant('s', 'client'),
                /* Connected on demand, never by BlueZ on its own. */
                AutoConnect: new GLib.Variant('b', false),
            }])).catch(e => {
            if (isDBusError(e, 'org.bluez.Error.AlreadyExists'))
                return;
            this._registration = null;
            throw e;
        });
        return this._registration;
    }

    /* bluetoothd stopped, and its registrations went with it. */
    forget() {
        this._registration = null;
    }

    destroy() {
        if (this._registration) {
            this._bluez.callAndForget(PROFILE_MANAGER_PATH, PROFILE_MANAGER_IFACE,
                'UnregisterProfile', new GLib.Variant('(o)', [this._path]));
            this._registration = null;
        }
        this._exported.unexport();
        this._exported = null;
    }

    /* org.bluez.Profile1, called by bluetoothd. */

    Release() {
        this._registration = null;
    }

    NewConnectionAsync([device, fdIndex], invocation) {
        let fd;
        try {
            fd = invocation.get_message().get_unix_fd_list().get(fdIndex);
        } catch (e) {
            invocation.return_dbus_error('org.bluez.Error.Rejected', e.message);
            return;
        }

        if (!this._onConnection(device, fd)) {
            try {
                GLib.close(fd);
            } catch {
                /* Nothing more to do with it. */
            }
            invocation.return_dbus_error('org.bluez.Error.Rejected',
                'Not a device this profile is waiting for');
            return;
        }
        invocation.return_value(null);
    }

    RequestDisconnectionAsync([device], invocation) {
        this._onDisconnection(device);
        invocation.return_value(null);
    }
}
