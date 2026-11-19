// SPDX-License-Identifier: GPL-3.0-or-later
/* brands.js: who makes a pair of headphones, and which model they are, from
 * the name they go by. The menu's header shows the model as its title and
 * the maker under it.
 *
 * Most headphones put their maker first ("realme Buds T500 Pro"). Some go by
 * a product line alone ("WH-1000XM5", "Galaxy Buds2 Pro"), whose maker the
 * line gives away, or failing that the protocol the headphones speak. */

/* As each maker writes its own name. */
const BRANDS = [
    'realme', 'OnePlus', 'OPPO', 'Sony', 'Samsung', 'Apple', 'Beats', 'Bose',
    'Nothing', 'CMF', 'Xiaomi', 'Redmi', 'Soundcore', 'Anker', 'JBL', 'QCY',
    'SoundPEATS', 'Jabra', 'Sennheiser', 'Edifier', 'Hoco', 'Lenovo',
    'Oraimo', 'Joyroom', 'Ugreen', 'Moondrop', 'Huawei', 'Honor', 'Google',
    'Skullcandy', 'Marshall', 'Shokz', 'Baseus', 'Haylou', 'TOZO', 'boAt',
    'Beyerdynamic', 'Audio-Technica', 'AKG', 'Philips', 'Panasonic',
    'Technics', 'Logitech', 'Razer', 'SteelSeries', 'HyperX', 'Corsair',
    'Plantronics', 'Poly', 'vivo', 'iQOO', 'Motorola', 'Nokia', 'LG',
];

/* Product lines whose names leave out their maker. */
const LINES = [
    [/^(AirPods|EarPods)\b/i, 'Apple'],
    [/^Powerbeats\b/i, 'Beats'],
    [/^Galaxy Buds/i, 'Samsung'],
    [/^(WH|WF|WI|MDR)-|^LinkBuds\b/i, 'Sony'],
    [/^(QuietComfort|QC(?=[\s\d]))/i, 'Bose'],
    [/^Ear ?\(/i, 'Nothing'],
    [/^Pixel Buds\b/i, 'Google'],
    [/^(FreeBuds|FreeClip|FreeLace)\b/i, 'Huawei'],
    [/^Enco\b/i, 'OPPO'],
];

/* The makers of the backends that speak to one maker's headphones only; the
 * OPPO protocol is realme's and OnePlus's too. */
const BACKEND_BRANDS = {
    apple: 'Apple',
    bose: 'Bose',
    nothing: 'Nothing',
    samsung: 'Samsung',
    sony: 'Sony',
    soundcore: 'Soundcore',
    xiaomi: 'Xiaomi',
};

/* {brand, model} where `text` starts with a maker's name and has more after
 * it, or null. A word that only starts like one ("Sonya") is not one. */
function splitBrand(text) {
    const lower = text.toLowerCase();
    for (const brand of BRANDS) {
        if (!lower.startsWith(brand.toLowerCase()))
            continue;
        const rest = text.slice(brand.length);
        if (/^[\p{L}\p{N}]/u.test(rest))
            continue;
        const model = rest.replace(/^[\s\-_:.,]+/, '').trim();
        if (model)
            return {brand, model};
    }
    return null;
}

function lineBrand(text) {
    return LINES.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/* {brand, model}: the maker, or null when it is not known, and the model,
 * which is the whole name where the maker is not in it. `alias` is the name
 * the user may have given them, `name` their own, and `backend` the id of the
 * backend that speaks to them, if any. */
export function identify({name = '', alias = '', backend = null} = {}) {
    name = name.trim();
    const shown = alias.trim() || name;

    const split = splitBrand(shown);
    if (split)
        return split;

    /* Renamed, the headphones still go by their own name underneath. */
    const brand = splitBrand(name)?.brand ?? lineBrand(shown) ?? lineBrand(name) ??
        BACKEND_BRANDS[backend] ?? null;
    return {brand, model: shown};
}
