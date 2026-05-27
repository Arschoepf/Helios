//Country flag SVGs for the LiDAR-View mode-bar button. When a native LiDAR provider matches the home position the button swaps
//its default globe glyph for the flag of the provider's host country, signalling at-a-glance which data source is feeding the
//shadows. Local-nDSM (user upload) and "no provider" keep their Material Design icons (harddisk + cloud-off respectively); only
//the native online providers get a flag.
//
//Each SVG is hand-trimmed for compactness: no doctype, no xmlns, no extra whitespace, since they ship inline in the card render path. viewBox uses
//the canonical aspect ratio per flag spec so Lit's unsafeSVG embeds them at the button's CSS size without distortion. Total bundle cost: ~1 kB
//minified.
//
//Adding a country = drop an entry in PROVIDER_TO_COUNTRY (or extend the existing prefix match), then add the matching SVG in
//COUNTRY_FLAG_SVG. The flag set is intentionally country-level rather than state-level, all German Bundesländer share the
//national flag rather than each carrying their own regional banner, which keeps the bundle small and the visual cue "you're in
//country X" obvious at 22 px.

const SVG_FR =
    '<svg viewBox="0 0 3 2"><rect width="1" height="2" fill="#002654"/>' +
    '<rect x="1" width="1" height="2" fill="#fff"/>' +
    '<rect x="2" width="1" height="2" fill="#ce1126"/></svg>';

//Union Jack, simplified. Two diagonal cross stripes + horizontal + vertical cross. Drops the offset Cross of St Patrick detail that a pixel-perfect
//Union Jack would carry, which would balloon the path size without being legible at 22 px.
const SVG_UK =
    '<svg viewBox="0 0 60 30">' +
    '<rect width="60" height="30" fill="#012169"/>' +
    '<path d="M0,0 60,30 M60,0 0,30" stroke="#fff" stroke-width="6"/>' +
    '<path d="M0,0 60,30 M60,0 0,30" stroke="#C8102E" stroke-width="3"/>' +
    '<path d="M30,0 V30 M0,15 H60" stroke="#fff" stroke-width="10"/>' +
    '<path d="M30,0 V30 M0,15 H60" stroke="#C8102E" stroke-width="6"/></svg>';

const SVG_ES =
    '<svg viewBox="0 0 3 2"><rect width="3" height="2" fill="#aa151b"/>' +
    '<rect y="0.5" width="3" height="1" fill="#f1bf00"/></svg>';

const SVG_NL =
    '<svg viewBox="0 0 3 2"><rect width="3" height="2" fill="#21468b"/>' +
    '<rect width="3" height="1.333" fill="#fff"/>' +
    '<rect width="3" height="0.667" fill="#ae1c28"/></svg>';

//Norway: red field, white-bordered blue Nordic cross.
const SVG_NO =
    '<svg viewBox="0 0 22 16"><rect width="22" height="16" fill="#ef2b2d"/>' +
    '<rect width="22" height="4" y="6" fill="#fff"/>' +
    '<rect width="4" height="16" x="6" fill="#fff"/>' +
    '<rect width="22" height="2" y="7" fill="#002868"/>' +
    '<rect width="2" height="16" x="7" fill="#002868"/></svg>';

const SVG_DE =
    '<svg viewBox="0 0 3 2"><rect width="3" height="2" fill="#ffce00"/>' +
    '<rect width="3" height="1.333" fill="#dd0000"/>' +
    '<rect width="3" height="0.667" fill="#000"/></svg>';

const SVG_PL =
    '<svg viewBox="0 0 8 5"><rect width="8" height="5" fill="#dc143c"/>' +
    '<rect width="8" height="2.5" fill="#fff"/></svg>';

//Canada: red-white-red with a stylised maple leaf. The leaf is a symmetric 11-vertex polygon, recognisable at 22 px without the full Pearson 11-point
//detail.
const SVG_CA =
    '<svg viewBox="0 0 24 12">' +
    '<path d="M0,0h6v12H0zM18,0h6v12h-6z" fill="#ff0000"/>' +
    '<rect x="6" width="12" height="12" fill="#fff"/>' +
    '<path d="M12,2.2 12.6,3.7 14.4,3.4 13.6,4.8 15.4,5.4 14,6.3 14.7,7.6 13.2,7.3 13.4,8.9 12,8 10.6,8.9 10.8,7.3 9.3,7.6 10,6.3 8.6,5.4 10.4,4.8 9.6,3.4 11.4,3.7Z" fill="#ff0000"/></svg>';

//US flag, simplified: full stripes, plain canton (no stars), which reads as "American flag" at 22 px while keeping the SVG small.
const SVG_US =
    '<svg viewBox="0 0 30 16"><rect width="30" height="16" fill="#fff"/>' +
    '<g fill="#b22234">' +
    '<rect width="30" height="1.23"/>' +
    '<rect y="2.46" width="30" height="1.23"/>' +
    '<rect y="4.92" width="30" height="1.23"/>' +
    '<rect y="7.38" width="30" height="1.23"/>' +
    '<rect y="9.85" width="30" height="1.23"/>' +
    '<rect y="12.31" width="30" height="1.23"/>' +
    '<rect y="14.77" width="30" height="1.23"/>' +
    '</g><rect width="12" height="8.61" fill="#3c3b6e"/></svg>';

const COUNTRY_FLAG_SVG: Record<string, string> = {
    fr: SVG_FR,
    uk: SVG_UK,
    es: SVG_ES,
    nl: SVG_NL,
    no: SVG_NO,
    de: SVG_DE,
    pl: SVG_PL,
    ca: SVG_CA,
    us: SVG_US,
};

//LiDAR source id -> ISO-3166-1 alpha-2 country code. State-level providers (German Länder) resolve to their parent country flag.
const PROVIDER_TO_COUNTRY: Record<string, string> = {
    'fr-ign-lidarhd':              'fr',
    'uk-defra-lidar-composite':    'uk',
    'es-pnoa-lidar':               'es',
    'nl-pdok-ahn4':                'nl',
    'no-kartverket-nhm':           'no',
    'de-nrw-ndom':                 'de',
    'de-bb-be-dom':                'de',
    'pl-gugik-nmpt':               'pl',
    'ca-hrdem':                    'ca',
    'us-vt-vcgi-ndsm':             'us',
};

//Returns the inline SVG flag for a given LiDAR source id, or null when the source is not in the registry (e.g. local-nDSM upload,
//future providers added before the flag set is updated). The card render path falls back to its default Material Design glyph
//when this returns null.
export function flagSvgForProvider(sourceId: string | null): string | null
{
    if (!sourceId) return null;
    const country = PROVIDER_TO_COUNTRY[sourceId];
    if (!country) return null;
    return COUNTRY_FLAG_SVG[country] ?? null;
}
