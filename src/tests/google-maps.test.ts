import { describe, expect, it } from 'vitest';
import { resolveGoogleMapsLink } from '../modules/room/google-maps.js';

describe('Google Maps venue resolver', () => {
  it('extracts coordinates from a canonical Google Maps link without a network request', async () => {
    await expect(resolveGoogleMapsLink('https://www.google.com/maps/@21.1458,106.0781,15z')).resolves.toEqual({
      latitude: 21.1458,
      longitude: 106.0781,
    });
  });

  it('rejects a non-Google URL', async () => {
    await expect(resolveGoogleMapsLink('https://example.com/maps/@21.1458,106.0781')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
