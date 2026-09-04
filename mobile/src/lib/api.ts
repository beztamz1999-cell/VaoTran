export const API_BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').replace(/\/$/, '');

export type ApiErrorCode = 'UNAUTHENTICATED' | 'INVALID_CREDENTIALS' | 'EMAIL_ALREADY_REGISTERED' | 'PHONE_ALREADY_REGISTERED' | 'VALIDATION_ERROR' | string;

export class ApiError extends Error {
  constructor(public readonly code: ApiErrorCode, message: string, public readonly status: number) { super(message); }
}

export type Me = { id: string; email: string | null; phone: string; display_name: string; avatar_url: string | null; birth_year: number | null; gender: string | null; home_area: string | null; created_at: string; reliability: unknown; sports: { sport: string; skill_state: string; skill_score: number | null; rank_tier: number | null }[] };
export type RoomImage = { id: string; url: string; mimeType: string; sortOrder: number; isCover: boolean };
export type PreferredSkill = { min_score: number | null; max_score: number | null };
export type RoomCard = { room_id: string; sport: string; title: string | null; venue: { name: string; address: string | null }; schedule: { start_at: string; end_at: string }; capacity: { available_public_slots: number; required_slots: number }; participation_fee_per_person: number; preferred_skill: PreferredSkill; cover_image_url: string | null; host: { user_id: string; display_name: string }; badges: string[] };
export type RoomDetail = { id: string; sport: string; status: string; venue: { name: string; address: string | null; latitude?: number | null; longitude?: number | null }; images: RoomImage[]; schedule: { start_at: string; end_at: string }; capacity: { total: number; available_public_slots: number }; participation_fee_per_person: number; preferred_skill: PreferredSkill; host: { id: string; display_name: string; avatar_url: string | null; sport_profile: unknown | null }; viewer: null | { is_host: boolean; schedule_conflict: boolean; can_request_join: boolean; application: null | { id: string; status: string }; participant: null | { id: string; status: string }; available_actions: string[] } };
export type Matches = { pending: unknown[]; upcoming: unknown[]; in_progress: unknown[]; completed: unknown[]; hosting: { room_id: string; title: string | null; sport: string; room_status: string; start_at: string; venue: { name: string }; capacity: { total: number; available_public_slots: number }; pending_application_count: number }[] };
export type CreateRoomInput = { sport_code: string; title: string | null; venue: { name: string; address: string | null; latitude?: number | null; longitude?: number | null }; scheduled_start_at: string; scheduled_end_at: string; capacity: number; host_participates: boolean; reserved_external_count: number; price_amount: number | null; participation_fee_per_person: number; currency: 'VND'; preferred_skill: { min_score?: number; max_score?: number } | null; equipment: { supply_mode: 'HOST_PROVIDES' | 'PLAYER_BRINGS' | 'MIXED' | 'NOT_APPLICABLE'; quantity_per_participant?: number | null; notes?: string | null; allowed_options: { display_name: string }[] }; allow_emergency_replacement: boolean };
export type HostApplication = { application_id: string; requested_by_user_id: string; requested_slot_count: number; status: string; requested_at: string; members: { display_name: string | null }[]; allowed_actions: string[] };
export type HostParticipant = { participant_id: string; display_name: string | null; attendance_status: 'NOT_SET' | 'PRESENT' | 'NO_SHOW'; skill: null | { state: 'UNRANKED' | 'CALIBRATING' | 'RANKED' | 'TOP_TIER_LOCKED'; score: number | null; rank_tier: number | null; valid_rating_count: number; confidence_level: 'LOW' | 'MEDIUM' | 'HIGH' | null }; rating: null | { eligible: boolean; rating_submitted: boolean; reason: string }; allowed_actions: string[] };
export type HostManager = RoomDetail & { manager: { available_public_slots: number; accepted_participants: HostParticipant[]; pending_applications: HostApplication[]; waitlisted_applications: HostApplication[]; allowed_actions: string[] } };

class ApiClient {
  private token: string | null = null;
  onUnauthenticated: (() => void) | null = null;
  setToken(token: string | null) { this.token = token; }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!API_BASE_URL) throw new ApiError('VALIDATION_ERROR', 'Chưa cấu hình EXPO_PUBLIC_API_BASE_URL.', 0);
    const mutation = init.method && !['GET', 'HEAD'].includes(init.method);
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers: { Accept: 'application/json', ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(mutation && path !== '/api/v1/auth/register' && path !== '/api/v1/auth/login' && path !== '/api/v1/auth/logout' ? { 'Idempotency-Key': `${Date.now()}-${Math.random().toString(36).slice(2)}` } : {}), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...init.headers } });
    } catch {
      throw new ApiError('NETWORK_ERROR', 'Không thể kết nối tới máy chủ. Vui lòng kiểm tra kết nối.', 0);
    }
    if (response.status === 204) return undefined as T;
    const body = await response.json().catch(() => null) as { data?: T; error?: { code?: string; message?: string } } | null;
    if (!response.ok) { if (response.status === 401) { this.token = null; this.onUnauthenticated?.(); } throw new ApiError(body?.error?.code ?? 'NETWORK_ERROR', body?.error?.message ?? 'Không thể kết nối máy chủ.', response.status); }
    return body?.data as T;
  }
  register(input: { email: string; password: string; display_name: string; phone: string }) { return this.request<{ access_token: string; user: Me }>('/api/v1/auth/register', { method: 'POST', body: JSON.stringify(input) }); }
  login(input: { email: string; password: string }) { return this.request<{ access_token: string; user: Me }>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify(input) }); }
  logout() { return this.request<void>('/api/v1/auth/logout', { method: 'POST' }); }
  me() { return this.request<Me>('/api/v1/me'); }
  updateMe(input: Partial<Pick<Me, 'display_name' | 'phone' | 'avatar_url' | 'birth_year' | 'gender' | 'home_area'>>) { return this.request<Me>('/api/v1/me', { method: 'PATCH', body: JSON.stringify(input) }); }
  search(sport: string) { return this.request<RoomCard[]>(`/api/v1/search/rooms?sport=${encodeURIComponent(sport)}`); }
  room(roomId: string) { return this.request<RoomDetail>(`/api/v1/rooms/${roomId}`); }
  requestJoin(roomId: string) { return this.request(`/api/v1/rooms/${roomId}/applications`, { method: 'POST', body: JSON.stringify({}) }); }
  withdraw(applicationId: string) { return this.request(`/api/v1/applications/${applicationId}/withdraw`, { method: 'POST', body: JSON.stringify({}) }); }
  matches() { return this.request<Matches>('/api/v1/me/rooms'); }
  createRoom(input: CreateRoomInput) { return this.request<{ room_id: string; status: string; version: number }>('/api/v1/rooms', { method: 'POST', body: JSON.stringify(input) }); }
  updateRoom(roomId: string, input: { participation_fee_per_person: number }) { return this.request<{ room_id: string; status: string; available_public_slots: number; version: number }>(`/api/v1/rooms/${roomId}`, { method: 'PATCH', body: JSON.stringify(input) }); }
  resolveGoogleMaps(url: string) { return this.request<{ latitude: number; longitude: number }>('/api/v1/venues/resolve-google-maps', { method: 'POST', body: JSON.stringify({ google_maps_url: url }) }); }
  publishRoom(roomId: string, expectedVersion?: number) { return this.request(`/api/v1/rooms/${roomId}/publish`, { method: 'POST', body: JSON.stringify(expectedVersion ? { expected_version: expectedVersion } : {}) }); }
  acceptApplication(applicationId: string) { return this.request(`/api/v1/applications/${applicationId}/accept`, { method: 'POST', body: JSON.stringify({}) }); }
  rejectApplication(applicationId: string) { return this.request(`/api/v1/applications/${applicationId}/reject`, { method: 'POST', body: JSON.stringify({}) }); }
  startRoom(roomId: string) { return this.request(`/api/v1/rooms/${roomId}/start`, { method: 'POST', body: JSON.stringify({}) }); }
  markPresent(participantId: string) { return this.request(`/api/v1/participants/${participantId}/attendance/present`, { method: 'POST', body: JSON.stringify({}) }); }
  markNoShow(participantId: string) { return this.request(`/api/v1/participants/${participantId}/attendance/no-show`, { method: 'POST', body: JSON.stringify({}) }); }
  completeRoom(roomId: string) { return this.request(`/api/v1/rooms/${roomId}/complete`, { method: 'POST', body: JSON.stringify({}) }); }
  async uploadRoomImage(roomId: string, uri: string, mimeType = 'image/jpeg') { const form = new FormData(); if (typeof window !== 'undefined') { const blob = await (await fetch(uri)).blob(); form.append('image', blob, 'venue.jpg'); } else form.append('image', { uri, type: mimeType, name: 'venue.jpg' } as unknown as Blob); return this.request<RoomImage>(`/api/v1/rooms/${roomId}/images`, { method: 'POST', body: form, headers: {} }); }
  deleteRoomImage(roomId: string, imageId: string) { return this.request<void>(`/api/v1/rooms/${roomId}/images/${imageId}`, { method: 'DELETE' }); }
  setRoomImageCover(roomId: string, imageId: string) { return this.request<void>(`/api/v1/rooms/${roomId}/images/${imageId}/cover`, { method: 'POST', body: JSON.stringify({}) }); }
  submitSkillRating(participantId: string, ratingValue: number) { return this.request(`/api/v1/participants/${participantId}/skill-rating`, { method: 'POST', body: JSON.stringify({ rating_value: ratingValue }) }); }
  hostManager(roomId: string) { return this.request<HostManager>(`/api/v1/host/rooms/${roomId}`); }
}

export const api = new ApiClient();
export const friendlyError = (error: unknown) => {
  if (!(error instanceof ApiError)) return 'Có lỗi không mong muốn. Vui lòng thử lại.';
  if (error.code === 'INVALID_CREDENTIALS') return 'Email hoặc mật khẩu chưa đúng.';
  if (error.code === 'EMAIL_ALREADY_REGISTERED') return 'Email này đã được đăng ký.';
  if (error.code === 'PHONE_ALREADY_REGISTERED') return 'Số điện thoại này đã được đăng ký.';
  if (error.code === 'ATTENDANCE_INCOMPLETE') return 'Chưa thể hoàn thành trận vì vẫn còn người chơi chưa được điểm danh.';
  if (error.status === 401) return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
  if (error.status === 409) return 'Trạng thái trận đã thay đổi hoặc không còn chỗ. Vui lòng tải lại.';
  if (error.status === 400 || error.status === 422) return 'Thông tin chưa hợp lệ. Vui lòng kiểm tra lại các trường đã nhập.';
  if (error.status >= 500) return 'Máy chủ đang gặp sự cố. Vui lòng thử lại sau.';
  if (error.status === 0) return error.message;
  return error.message || 'Yêu cầu chưa thể thực hiện.';
};
