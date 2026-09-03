import { DomainError } from '../../platform/core.js';

const googleHosts = new Set(['maps.app.goo.gl', 'goo.gl', 'maps.google.com', 'www.google.com', 'google.com']);

const validGoogleUrl = (value: URL) => value.protocol === 'https:' && googleHosts.has(value.hostname.toLowerCase());

const extractCoordinates = (value: string): { latitude: number; longitude: number } | null => {
  const match = value.match(/@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/)
    ?? value.match(/!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/)
    ?? value.match(/[?&](?:q|query|ll)=(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    ? { latitude, longitude }
    : null;
};

/** Resolves only Google Maps redirect chains, never an arbitrary user-controlled host. */
export async function resolveGoogleMapsLink(input: string): Promise<{ latitude: number; longitude: number }> {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new DomainError('VALIDATION_ERROR', 'Link Google Maps không hợp lệ.'); }
  if (!validGoogleUrl(url)) throw new DomainError('VALIDATION_ERROR', 'Chỉ nhận link chia sẻ từ Google Maps.');

  for (let redirects = 0; redirects < 6; redirects += 1) {
    const direct = extractCoordinates(url.toString());
    if (direct) return direct;
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(6_000), headers: { 'user-agent': 'VaoTran venue resolver/1.0' } });
    } catch { throw new DomainError('VALIDATION_ERROR', 'Không thể đọc link Google Maps lúc này.'); }
    const location = response.headers.get('location');
    if (!location) break;
    url = new URL(location, url);
    if (!validGoogleUrl(url)) throw new DomainError('VALIDATION_ERROR', 'Link Google Maps chuyển hướng không an toàn.');
  }
  throw new DomainError('VALIDATION_ERROR', 'Không đọc được toạ độ từ link này. Hãy dùng “Chia sẻ” trong Google Maps và dán lại link.');
}
