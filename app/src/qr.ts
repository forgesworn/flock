import { encode, toSvg } from '@forgesworn/qr'

/**
 * The invite and npub QR codes, as a scalable SVG string. Level 'L' (7% EC):
 * scanning a clean screen has no damage to correct for, so the lowest EC gives
 * the sparsest code, with fewer, bigger modules that a phone camera resolves far
 * more easily than the denser 'M'. The 4 module quiet zone the spec needs to
 * detect the finder pattern is baked into the SVG so it scales with the code;
 * black on white, sized by the stylesheet. Throws if the text does not fit.
 */
export function qrSvg(text: string): string {
  return toSvg(encode(text, { ecc: 'L' }), { margin: 4, dark: '#000', light: '#fff' })
}
