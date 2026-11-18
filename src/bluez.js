// SPDX-License-Identifier: GPL-3.0-or-later
/* bluez.js: the Bluetooth devices BlueZ knows, from its object manager on the
 * system bus, and calls into BlueZ. */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const BLUEZ = 'org.bluez';
const ADAPTER_IFACE = 'org.bluez.Adapter1';
const DEVICE_IFACE = 'org.bluez.Device1';
const BATTERY_IFACE = 'org.bluez.Battery1';

/* Connecting a profile can wait out a page timeout and a retry or two. */
const CALL_TIMEOUT_MS = 30000;

export const BluezClient = GObject.registerClass({
    Signals: {
        /* A device came, went, or changed; the argument is its object path. */
        'device-changed': {param_types: [GObject.TYPE_STRING]},
        /* bluetoothd started or stopped. */
        'service-changed': {},
    },
}, class BluezClient extends GObject.Object {
    _init() {
        super._init();

        this._manager = null;
        this._cancellable = new Gio.Cancellable();

        Gio.DBusObjectManagerClient.new_for_bus(Gio.BusType.SYSTEM,
            Gio.DBusObjectManagerClientFlags.NONE, BLUEZ, '/', null,
            this._cancellable, (_source, result) => {
                try {
                    this._manager = Gio.DBusObjectManagerClient.new_for_bus_finish(result);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`Earshot: cannot watch BlueZ: ${e.message}`);
                    return;
                }

                const onObject = (_manager, object) =>
                    this.emit('device-changed', object.get_object_path());
                this._manager.connectObject(
                    'object-added', onObject,
                    'object-removed', onObject,
                    'interface-added', onObject,
                    'interface-removed', onObject,
                    'interface-proxy-properties-changed', onObject,
                    'notify::name-owner', () => this.emit('service-changed'),
                    this);
                this.emit('service-changed');
            });
    }

    /* Whether bluetoothd is running. */
    get available() {
        return !!this._manager?.nameOwner;
    }

    get devicePaths() {
        if (!this._manager)
            return [];
        return this._manager.get_objects()
            .filter(object => object.get_interface(DEVICE_IFACE))
            .map(object => object.get_object_path());
    }

    /* This computer's Bluetooth addresses, upper case. */
    get adapterAddresses() {
        if (!this._manager)
            return [];
        return this._manager.get_objects()
            .map(object => object.get_interface(ADAPTER_IFACE)
                ?.get_cached_property('Address')?.unpack())
            .filter(address => address)
            .map(address => address.toUpperCase());
    }

    /* {path, name, alias, icon, connected, uuids, vendor, product, battery,
     * localAddresses}, or null when there is no such device. `vendor` and
     * `product` are the maker's and model's ids from the device id record, or
     * null. `battery` is BlueZ's one percentage for the whole device, or
     * null. `localAddresses` are this computer's, to know it in the
     * headphones' list of devices. */
    getDevice(path) {
        const object = this._manager?.get_object(path);
        const device = object?.get_interface(DEVICE_IFACE);
        if (!device)
            return null;

        const property = name => device.get_cached_property(name)?.deepUnpack() ?? null;
        const battery = object.get_interface(BATTERY_IFACE)
            ?.get_cached_property('Percentage')?.unpack() ?? null;
        /* "bluetooth:v004Cp2014d0F14" */
        const modalias = /:v([0-9a-f]{4})p([0-9a-f]{4})/i.exec(property('Modalias') ?? '');

        return {
            path,
            name: property('Name') ?? '',
            alias: property('Alias') ?? '',
            icon: property('Icon') ?? '',
            connected: property('Connected') === true,
            vendor: modalias ? parseInt(modalias[1], 16) : null,
            product: modalias ? parseInt(modalias[2], 16) : null,
            localAddresses: this.adapterAddresses,
            uuids: (property('UUIDs') ?? []).map(uuid => uuid.toLowerCase()),
            battery,
        };
    }

    /* Resolves to the reply, rejects with the D-Bus error. */
    call(path, iface, method, params) {
        return new Promise((resolve, reject) => {
            Gio.DBus.system.call(BLUEZ, path, iface, method, params, null,
                Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, this._cancellable,
                (connection, result) => {
                    try {
                        resolve(connection.call_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    /* Not cancelled with this client: for the unregistering done while
     * shutting down. */
    callAndForget(path, iface, method, params) {
        Gio.DBus.system.call(BLUEZ, path, iface, method, params, null,
            Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                try {
                    connection.call_finish(result);
                } catch {
                    /* bluetoothd is gone, and the registration with it. */
                }
            });
    }

    destroy() {
        this._cancellable.cancel();
        this._manager?.disconnectObject(this);
        this._manager = null;
    }
});

/* Whether `error` is the D-Bus error `name`. */
export function isDBusError(error, name) {
    return error instanceof GLib.Error &&
        Gio.DBusError.is_remote_error(error) &&
        Gio.DBusError.get_remote_error(error) === name;
}
