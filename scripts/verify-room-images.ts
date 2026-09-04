const baseUrl = process.env.VAOTRAN_API_URL ?? 'http://127.0.0.1:3000';
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const password = 'PrivateAlpha!2026';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL6ZQAAAABJRU5ErkJggg==', 'base64');

type ApiResponse<T> = { data: T };
type Account = { token: string; userId: string };
type Image = { id: string; url: string; isCover: boolean; sortOrder: number };

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message);
};

const request = async <T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: T;
  try { body = text ? JSON.parse(text) as T : undefined as T; } catch { throw new Error(`${path} returned non-JSON (${response.status}): ${text}`); }
  return { status: response.status, body };
};

const json = <T>(path: string, body: unknown, token?: string, idempotencyKey?: string) => request<T>(path, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  },
  body: JSON.stringify(body),
});

const register = async (role: string): Promise<Account> => {
  const result = await json<ApiResponse<{ access_token: string; user: { id: string } }>>('/api/v1/auth/register', {
    email: `room-images-${role}-${suffix}@example.test`, password, display_name: `Image ${role}`, phone: `09${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0')}`,
  });
  assert(result.status === 201, `Register ${role} failed (${result.status})`);
  return { token: result.body.data.access_token, userId: result.body.data.user.id };
};

const upload = (roomId: string, token: string, contents = png) => {
  const form = new FormData();
  form.append('image', new Blob([contents], { type: 'image/png' }), 'court.png');
  return request<ApiResponse<Image>>(`/api/v1/rooms/${roomId}/images`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
};

const roomInput = (name: string) => ({
  sport_code: 'BADMINTON', title: name,
  venue: { name: 'Sân xác minh ảnh', address: 'Bắc Ninh', latitude: 21.1861, longitude: 106.0763 },
  scheduled_start_at: '2026-12-01T12:00:00.000Z', scheduled_end_at: '2026-12-01T14:00:00.000Z',
  capacity: 4, host_participates: true, reserved_external_count: 0, price_amount: null, participation_fee_per_person: 50000, currency: 'VND', preferred_skill: null,
  equipment: { supply_mode: 'HOST_PROVIDES', quantity_per_participant: null, notes: null, allowed_options: [{ display_name: 'Cầu' }] },
  allow_emergency_replacement: true,
});

const createRoom = async (host: Account, name: string) => {
  const result = await json<ApiResponse<{ room_id: string }>>('/api/v1/rooms', roomInput(name), host.token, `room-images-create-${suffix}-${name}`);
  assert(result.status === 201, `Create room failed (${result.status})`);
  return result.body.data.room_id;
};

const main = async (): Promise<void> => {
  const health = await request<ApiResponse<{ status: string }>>('/health');
  const ready = await request<ApiResponse<{ status: string; database: string }>>('/health/ready');
  assert(health.status === 200 && health.body.data.status === 'ok', 'Health check failed');
  assert(ready.status === 200 && ready.body.data.status === 'ready' && ready.body.data.database === 'ok', 'Readiness check failed');

  const host = await register('host');
  const player = await register('player');
  const roomId = await createRoom(host, `Room images ${suffix}`);
  const [first, second, third] = await Promise.all([upload(roomId, host.token), upload(roomId, host.token), upload(roomId, host.token)]);
  for (const result of [first, second, third]) assert(result.status === 201, `Host upload failed (${result.status})`);
  const images = [first.body.data, second.body.data, third.body.data];
  assert(images.filter((image) => image.isCover).length === 1, 'First upload did not establish exactly one cover');

  const list = await request<ApiResponse<Image[]>>(`/api/v1/rooms/${roomId}/images`);
  assert(list.status === 200 && list.body.data.length === 3, 'Public image list is incomplete');
  const staticImage = await fetch(`${baseUrl}${list.body.data[0]!.url}`);
  assert(staticImage.status === 200 && staticImage.headers.get('content-type') === 'image/png', 'Static image route failed');

  const nonHostUpload = await upload(roomId, player.token);
  assert(nonHostUpload.status === 403, `Non-host upload should be forbidden, got ${nonHostUpload.status}`);
  const invalidUpload = await upload(roomId, host.token, Buffer.from('not-an-image'));
  assert(invalidUpload.status === 400, `Invalid image should be rejected, got ${invalidUpload.status}`);
  const overLimit = await upload(roomId, host.token);
  assert(overLimit.status === 400, `Fourth image should be rejected, got ${overLimit.status}`);

  const cover = await json<unknown>(`/api/v1/rooms/${roomId}/images/${images[1]!.id}/cover`, {}, host.token);
  assert(cover.status === 204, `Set cover failed (${cover.status})`);
  const afterCover = await request<ApiResponse<Image[]>>(`/api/v1/rooms/${roomId}/images`);
  assert(afterCover.body.data.filter((image) => image.isCover).length === 1 && afterCover.body.data.some((image) => image.id === images[1]!.id && image.isCover), 'Cover state is inconsistent');

  const deleteResponse = await request<undefined>(`/api/v1/rooms/${roomId}/images/${images[1]!.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${host.token}` } });
  assert(deleteResponse.status === 204, `Delete image failed (${deleteResponse.status})`);
  const afterDelete = await request<ApiResponse<Image[]>>(`/api/v1/rooms/${roomId}/images`);
  assert(afterDelete.body.data.length === 2 && afterDelete.body.data.filter((image) => image.isCover).length === 1, 'Cover fallback after deletion failed');

  const publish = await json<ApiResponse<{ status: string }>>(`/api/v1/rooms/${roomId}/publish`, {}, host.token, `room-images-publish-${suffix}`);
  assert(publish.status === 200 && publish.body.data.status === 'OPEN', `Publish room failed (${publish.status})`);
  const detail = await request<ApiResponse<{ images: Image[]; participation_fee_per_person: number }>>(`/api/v1/rooms/${roomId}`, { headers: { Authorization: `Bearer ${player.token}` } });
  assert(detail.status === 200 && detail.body.data.images.length === 2 && detail.body.data.participation_fee_per_person === 50000, 'Room detail does not expose images and fee');
  const search = await request<ApiResponse<Array<{ room_id: string; cover_image_url: string | null; participation_fee_per_person: number }>>>(`/api/v1/search/rooms?sport=BADMINTON&time_start=2026-12-01T00%3A00%3A00.000Z&time_end=2026-12-02T00%3A00%3A00.000Z`, { headers: { Authorization: `Bearer ${player.token}` } });
  assert(search.status === 200 && search.body.data.some((room) => room.room_id === roomId && room.cover_image_url && room.participation_fee_per_person === 50000), 'Search does not expose the cover image and fee');

  const emptyRoomId = await createRoom(host, `Room no images ${suffix}`);
  const emptyPublish = await json<ApiResponse<{ status: string }>>(`/api/v1/rooms/${emptyRoomId}/publish`, {}, host.token, `room-images-empty-publish-${suffix}`);
  assert(emptyPublish.status === 200 && emptyPublish.body.data.status === 'OPEN', 'Zero-image room cannot publish');
  const emptyDetail = await request<ApiResponse<{ images: Image[] }>>(`/api/v1/rooms/${emptyRoomId}`, { headers: { Authorization: `Bearer ${player.token}` } });
  assert(emptyDetail.status === 200 && emptyDetail.body.data.images.length === 0, 'Zero-image room detail is incorrect');

  console.log(JSON.stringify({ status: 'pass', roomId, emptyRoomId, hostUserId: host.userId, playerUserId: player.userId, imageCount: afterDelete.body.data.length }));
};

main().catch((error) => { console.error(error); process.exitCode = 1; });
