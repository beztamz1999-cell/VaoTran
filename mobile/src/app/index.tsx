import { useEffect, useState } from 'react';
import { Alert, Linking, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { api, friendlyError, type HostManager as HostManagerData, type Matches, type Me, type RoomCard, type RoomDetail } from '@/lib/api';
import { session } from '@/lib/session';
import { AppIcon, Avatar, Card, Chip, EmptyState, ErrorBanner, LoadingState, PrimaryButton, SecondaryButton, SectionHeader, StatusBadge, TextField } from '@/components/ui/app-ui';
import { colors, radius, shadow, space } from '@/theme';

type Tab = 'discover' | 'matches' | 'create' | 'profile';
const sports = ['BADMINTON', 'PICKLEBALL', 'TENNIS'];
const date = (value: string) => new Date(value).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const status = (value: string) => ({ REQUESTED: 'Chờ duyệt', WAITLISTED: 'Danh sách chờ', PRESENT: 'Có mặt', NO_SHOW: 'Vắng mặt', NOT_SET: 'Chưa điểm danh', OPEN: 'Đang mở', IN_PROGRESS: 'Đang diễn ra' }[value] ?? value);
const openGoogleMaps = (name: string, address: string | null, latitude?: number | null, longitude?: number | null) => {
  const query = latitude !== null && latitude !== undefined && longitude !== null && longitude !== undefined
    ? `${latitude},${longitude}`
    : [name, address].filter(Boolean).join(', ');
  void Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`);
};
const suggestedSessionTime = (hour: number) => {
  const next = new Date();
  if (next.getHours() >= hour) next.setDate(next.getDate() + 1);
  next.setHours(hour, 0, 0, 0);
  return next.toISOString();
};
const layout = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', backgroundColor: Platform.select({ web: colors.canvas, default: colors.background }) },
  surface: { flex: 1, width: '100%', maxWidth: Platform.select({ web: 460, default: undefined }), backgroundColor: colors.background, borderWidth: Platform.select({ web: 1, default: 0 }), borderColor: colors.border, ...(Platform.OS === 'web' ? shadow : {}) },
  authSurface: { width: '100%', maxWidth: Platform.select({ web: 440, default: undefined }), alignSelf: 'center', borderWidth: Platform.select({ web: 1, default: 0 }), borderColor: colors.border, ...(Platform.OS === 'web' ? shadow : {}) },
});

export default function App() {
  const [me, setMe] = useState<Me | null>(null); const [loading, setLoading] = useState(true); const [tab, setTab] = useState<Tab>('discover');
  useEffect(() => { void (async () => { const token = await session.get(); if (token) { api.setToken(token); try { setMe(await api.me()); } catch { await session.clear(); api.setToken(null); } } setLoading(false); })(); }, []);
  useEffect(() => { api.onUnauthenticated = () => { void session.clear(); setMe(null); }; return () => { api.onUnauthenticated = null; }; }, []);
  const signedIn = async (token: string) => { await session.set(token); api.setToken(token); setMe(await api.me()); };
  const signOut = async () => { try { await api.logout(); } catch {} await session.clear(); api.setToken(null); setMe(null); };
  if (loading) return <SafeAreaView style={layout.page}><View style={layout.surface}><LoadingState label="Đang kiểm tra phiên đăng nhập…" /></View></SafeAreaView>;
  if (!me) return <View style={layout.page}><Auth onSuccess={signedIn} /></View>;
  return <SafeAreaView style={layout.page}><View style={layout.surface}><View style={s.shell}>{tab === 'discover' && <Discovery me={me} />}{tab === 'matches' && <MatchesScreen />}{tab === 'create' && <Create />}{tab === 'profile' && <Profile me={me} setMe={setMe} signOut={signOut} />}</View><Nav tab={tab} setTab={setTab} /></View></SafeAreaView>;
}

function Auth({ onSuccess }: { onSuccess: (token: string) => Promise<void> }) {
  const [mode, setMode] = useState<'entry' | 'login' | 'register'>('entry'); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => { setBusy(true); setError(''); try { const result = mode === 'register' ? await api.register({ email, password, display_name: name, phone }) : await api.login({ email, password }); await onSuccess(result.access_token); } catch (e) { setError(friendlyError(e)); } finally { setBusy(false); } };
  if (mode === 'entry') return <SafeAreaView style={[s.entry, layout.authSurface]}><View style={s.entryHero}><Text style={s.logo}>VàoTrận</Text><Text style={s.tagline}>Tìm trận cầu lông quanh bạn{`\n`}Vào trận là có bạn!</Text><View style={s.court}><Text style={s.courtIcon}>⌁</Text></View></View><View style={s.entryActions}><PrimaryButton label="ĐĂNG NHẬP" onPress={() => setMode('login')} /><SecondaryButton label="ĐĂNG KÝ" onPress={() => setMode('register')} /><Text style={s.alpha}>Phiên bản Private Alpha</Text></View></SafeAreaView>;
  const register = mode === 'register';
  return <SafeAreaView style={[s.auth, layout.authSurface]}>
    <ScrollView contentContainerStyle={s.authBody} keyboardShouldPersistTaps="handled">
      <Pressable onPress={() => setMode('entry')}><Text style={s.back}>‹</Text></Pressable>
      <Text style={s.authTitle}>{register ? 'Tạo tài khoản mới' : 'Chào mừng trở lại 👋'}</Text>
      <Text style={s.authSub}>{register ? 'Tham gia cộng đồng VàoTrận' : 'Đăng nhập để tiếp tục hành trình'}</Text>
      <View style={s.form}>
        {register ? <TextField label="Tên hiển thị" value={name} onChangeText={setName} /> : null}
        <TextField label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" />
        {register ? <TextField label="Số điện thoại" value={phone} onChangeText={setPhone} keyboardType="phone-pad" /> : null}
        <TextField label="Mật khẩu" value={password} onChangeText={setPassword} secureTextEntry hint={register ? 'Ít nhất 10 ký tự' : undefined} />
        {error ? <ErrorBanner message={error} /> : null}
      </View>
      <PrimaryButton label={register ? 'ĐĂNG KÝ' : 'ĐĂNG NHẬP'} disabled={busy} onPress={() => void submit()} />
      <Pressable onPress={() => setMode(register ? 'login' : 'register')}><Text style={s.link}>{register ? 'Đã có tài khoản? Đăng nhập' : 'Chưa có tài khoản? Đăng ký ngay'}</Text></Pressable>
    </ScrollView>
  </SafeAreaView>;
}

function Discovery({ me }: { me: Me }) {
  const [sport, setSport] = useState('BADMINTON'); const [rooms, setRooms] = useState<RoomCard[]>([]); const [detail, setDetail] = useState<RoomDetail | null>(null); const [busy, setBusy] = useState(true); const [error, setError] = useState(''); const [filter, setFilter] = useState(false);
  useEffect(() => { void (async () => { setBusy(true); try { setRooms(await api.search(sport)); setError(''); } catch (e) { setError(friendlyError(e)); } finally { setBusy(false); } })(); }, [sport]);
  if (detail) return <RoomDetailScreen room={detail} back={() => setDetail(null)} refresh={async () => setDetail(await api.room(detail.id))} />;
  if (filter) return <Filters back={() => setFilter(false)} />;
  return <ScrollView contentContainerStyle={s.content}><View style={s.location}><Text style={s.locationText}>⌖ Việt Yên, Bắc Giang</Text><Text>♧</Text></View><Text style={s.greet}>Xin chào, {me.display_name}! 👋</Text><Text style={s.sub}>Sẵn sàng vào trận hôm nay?</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.sportList}>{sports.map((item, index) => <Pressable key={item} onPress={() => setSport(item)} style={[s.sport, sport === item && s.sportSelected]}><Text style={[s.sportMark, sport === item && s.white]}>{index === 0 ? '⌁' : index === 1 ? '◉' : '◌'}</Text><Text style={[s.sportText, sport === item && s.white]}>{item === 'BADMINTON' ? 'Cầu lông' : item}</Text></Pressable>)}</ScrollView><SectionHeader title="Trận gần bạn" action={<Pressable onPress={() => setFilter(true)}><Text style={s.link}>Bộ lọc</Text></Pressable>} />{error ? <ErrorBanner message={error} /> : busy ? <LoadingState /> : rooms.length ? rooms.map(room => <RoomCardView key={room.room_id} room={room} onPress={() => void api.room(room.room_id).then(setDetail).catch(e => setError(friendlyError(e)))} />) : <EmptyState title="Chưa có trận phù hợp" description="Hãy đổi môn thể thao hoặc quay lại sau nhé." />}</ScrollView>;
}
function RoomCardView({ room, onPress }: { room: RoomCard; onPress: () => void }) { return <Pressable onPress={onPress} style={s.roomCard}><View style={s.thumb}><Text style={s.thumbText}>⌁</Text></View><View style={{ flex: 1, gap: 4 }}><View style={s.cardTop}><Text style={s.meta}>{date(room.schedule.start_at)}</Text><StatusBadge label={`Còn ${room.capacity.available_public_slots}/${room.capacity.required_slots}`} tone="orange" /></View><Text style={s.roomTitle}>{room.title ?? room.venue.name}</Text><Text style={s.meta}>{room.venue.address ?? room.venue.name}</Text><Text style={s.small}>Trình độ: Mọi trình độ</Text></View></Pressable>; }

function RoomDetailScreen({ room, back, refresh }: { room: RoomDetail; back: () => void; refresh: () => Promise<void> }) { const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const actions = room.viewer?.available_actions ?? []; const join = async () => { setBusy(true); try { if (actions.includes('WITHDRAW_APPLICATION')) await api.withdraw(room.viewer!.application!.id); else await api.requestJoin(room.id); await refresh(); } catch (e) { setError(friendlyError(e)); } finally { setBusy(false); } }; const label = actions.includes('WITHDRAW_APPLICATION') ? 'RÚT YÊU CẦU' : actions.includes('REQUEST_JOIN') ? 'YÊU CẦU THAM GIA' : null; return <ScrollView contentContainerStyle={s.content}><Pressable onPress={back}><Text style={s.back}>‹</Text></Pressable><View style={s.hero}><Text style={s.heroIcon}>⌁</Text><StatusBadge label={`Còn ${room.capacity.available_public_slots}/${room.capacity.total} chỗ`} /></View><Text style={s.meta}>{date(room.schedule.start_at)} - {new Date(room.schedule.end_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</Text><Text style={s.detailTitle}>{room.venue.name}</Text><Text style={s.meta}>⌖ {room.venue.address ?? 'Chưa cập nhật địa chỉ'}</Text><SecondaryButton label="MỞ VỊ TRÍ TRÊN GOOGLE MAPS" onPress={() => openGoogleMaps(room.venue.name, room.venue.address)} />{error && <ErrorBanner message={error} />}<Card><SectionHeader title="Thông tin trận" /><Info label="Trình độ" value="Mọi trình độ" /><Info label="Sức chứa" value={`${room.capacity.total} người`} /><Info label="Trạng thái" value={status(room.status)} /></Card><Card><Text style={s.section}>Chủ sân</Text><View style={s.host}><Avatar name={room.host.display_name} /><View><Text style={s.roomTitle}>{room.host.display_name}</Text><Text style={s.meta}>Host của trận này</Text></View></View></Card>{room.viewer?.application && <StatusBadge label={status(room.viewer.application.status)} tone="orange" />}{label && <PrimaryButton label={label} disabled={busy} onPress={() => void join()} />}{actions.includes('OPEN_HOST_MANAGER') && <HostManager roomId={room.id} />}</ScrollView>; }
function Info({ label, value }: { label: string; value: string }) { return <View style={s.info}><Text style={s.meta}>{label}</Text><Text style={s.small}>{value}</Text></View>; }

function Filters({ back }: { back: () => void }) { const [open, setOpen] = useState(true); return <ScrollView contentContainerStyle={s.content}><View style={s.top}><Pressable onPress={back}><Text style={s.back}>‹</Text></Pressable><Text style={s.screen}>Bộ lọc tìm trận</Text><Pressable onPress={back}><Text style={s.link}>Xóa bộ lọc</Text></Pressable></View><Filter title="Thời gian" labels={['Hôm nay', 'Ngày mai', '7 ngày tới']} /><Filter title="Trình độ" labels={['Yếu - Trung bình', 'Trung bình - Khá', 'Khá - Giỏi']} /><Filter title="Khu vực" labels={['Việt Yên', 'Bắc Ninh', 'Bắc Giang']} /><View style={s.switchRow}><Text style={s.small}>Chỉ hiển thị trận còn chỗ</Text><Switch value={open} onValueChange={setOpen} trackColor={{ true: colors.brand }} /></View><PrimaryButton label="ÁP DỤNG BỘ LỌC" onPress={back} /></ScrollView>; }
function Filter({ title, labels }: { title: string; labels: string[] }) { const [active, setActive] = useState(0); return <View style={s.filter}><Text style={s.section}>{title}</Text><View style={s.chips}>{labels.map((x, i) => <Chip key={x} label={x} active={active === i} onPress={() => setActive(i)} />)}</View></View>; }

function MatchesScreen() { const [data, setData] = useState<Matches | null>(null); const [error, setError] = useState(''); useEffect(() => { void api.matches().then(setData).catch(e => setError(friendlyError(e))); }, []); if (!data) return error ? <ScrollView contentContainerStyle={s.content}><Text style={s.screen}>Trận của tôi</Text><ErrorBanner message={error} /></ScrollView> : <LoadingState label="Đang tải các trận của bạn…" />; const groups = [['Yêu cầu tham gia', data.pending], ['Sắp tới', data.upcoming], ['Đang diễn ra', data.in_progress], ['Đã hoàn thành', data.completed]] as const; return <ScrollView contentContainerStyle={s.content}><Text style={s.screen}>Trận của tôi</Text><View style={s.chips}><Chip label="Tất cả" active /><Chip label="Sắp tới" /><Chip label="Đang diễn ra" /><Chip label="Đã hoàn thành" /></View>{groups.map(([title, items]) => <View key={title} style={s.group}><SectionHeader title={title} />{items.length ? <Card><Text style={s.meta}>{items.length} trận trong mục này</Text></Card> : <EmptyState title={`Chưa có trận ${title.toLowerCase()}`} description="Các trận của bạn sẽ xuất hiện tại đây." />}</View>)}<SectionHeader title="Trận tôi tổ chức" />{data.hosting.length ? data.hosting.map(room => <HostManagerView key={room.room_id} roomId={room.room_id} label={room.title ?? room.venue.name} />) : <EmptyState title="Chưa có trận tổ chức" description="Tạo trận đầu tiên để mời mọi người cùng chơi." />}</ScrollView>; }

const createS = StyleSheet.create({
  venueBlock: { gap: 12 }, mapHint: { color: colors.muted, fontSize: 11, marginTop: -5 },
  scheduleBox: { gap: 12, backgroundColor: colors.section, borderRadius: radius.card, padding: 14, borderWidth: 1, borderColor: colors.border },
  scheduleTabs: { flexDirection: 'row', gap: 8 }, scheduleTab: { flex: 1, gap: 4, backgroundColor: '#fff', borderRadius: radius.input, borderWidth: 1, borderColor: colors.border, padding: 11 }, scheduleTabActive: { backgroundColor: colors.brand, borderColor: colors.brand }, scheduleTabText: { color: colors.muted, fontSize: 11, fontWeight: '800' }, scheduleTabTextActive: { color: '#fff' }, scheduleValue: { color: colors.text, fontSize: 12, fontWeight: '800' },
  calendar: { gap: 9, backgroundColor: '#fff', borderRadius: radius.input, padding: 10, borderWidth: 1, borderColor: colors.border }, calendarHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, monthArrow: { color: colors.brand, fontSize: 28, lineHeight: 28, paddingHorizontal: 8 }, monthTitle: { color: colors.text, fontSize: 14, fontWeight: '900', textTransform: 'capitalize' }, calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' }, weekday: { width: '14.2857%', textAlign: 'center', color: colors.muted, fontSize: 10, fontWeight: '800', paddingVertical: 5 }, dayCell: { width: '14.2857%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 20 }, daySelected: { backgroundColor: colors.brand }, dayText: { color: colors.text, fontSize: 13, fontWeight: '700' }, dayTextSelected: { color: '#fff' }, timeLabel: { color: colors.text, fontSize: 12, fontWeight: '800', marginTop: 1 },
});

function Create() {
  const [step, setStep] = useState(1);
  const [sport, setSport] = useState('BADMINTON');
  const [venue, setVenue] = useState('');
  const [address, setAddress] = useState('');
  const [googleMapsUrl, setGoogleMapsUrl] = useState('');
  const [coordinates, setCoordinates] = useState<{ latitude: number; longitude: number } | null>(null);
  const [resolvingMap, setResolvingMap] = useState(false);
  const [capacity, setCapacity] = useState(4);
  const [reserved, setReserved] = useState(0);
  const [plays, setPlays] = useState(true);
  const [start, setStart] = useState(() => suggestedSessionTime(19));
  const [end, setEnd] = useState(() => suggestedSessionTime(21));
  const [balls, setBalls] = useState('Thành Công');
  const [hostProvidesBalls, setHostProvidesBalls] = useState(true);
  const [ballsPerPlayer, setBallsPerPlayer] = useState(1);
  const [created, setCreated] = useState<{ room_id: string; version: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const resolveMap = async () => {
    if (!googleMapsUrl.trim()) return setError('Hãy dán link chia sẻ từ Google Maps.');
    setResolvingMap(true); setError('');
    try { setCoordinates(await api.resolveGoogleMaps(googleMapsUrl)); }
    catch (e) { setCoordinates(null); setError(friendlyError(e)); }
    finally { setResolvingMap(false); }
  };
  const create = async () => {
    const options = balls.split(',').map(x => x.trim()).filter(Boolean);
    if (!venue || !options.length || !coordinates || new Date(end) <= new Date(start)) {
      return setError('Hãy nhập tên sân, xác nhận link Google Maps, thời gian hợp lệ và loại cầu chơi.');
    }
    setBusy(true);
    try {
      setCreated(await api.createRoom({
        sport_code: sport, title: null, venue: { name: venue, address: address || null, ...coordinates },
        scheduled_start_at: start, scheduled_end_at: end, capacity, host_participates: plays,
        reserved_external_count: reserved, price_amount: null, currency: 'VND', preferred_skill: null,
        equipment: {
          supply_mode: hostProvidesBalls ? 'HOST_PROVIDES' : 'PLAYER_BRINGS',
          quantity_per_participant: hostProvidesBalls ? null : ballsPerPlayer,
          allowed_options: options.map(display_name => ({ display_name })),
        },
        allow_emergency_replacement: true,
      }));
    } catch (e) { setError(friendlyError(e)); } finally { setBusy(false); }
  };

  return <ScrollView contentContainerStyle={s.content}>
    <View style={s.top}><Text style={s.screen}>Tạo trận mới</Text><Text style={s.meta}>Bước {step}/2</Text></View>
    {error && <ErrorBanner message={error} />}
    {step === 1 ? <View style={s.form}>
      <Text style={s.section}>Môn thể thao</Text>
      <View style={s.chips}>{sports.map(x => <Chip key={x} label={x === 'BADMINTON' ? 'Cầu lông' : x} active={sport === x} onPress={() => setSport(x)} />)}</View>
      <SchedulePicker start={start} end={end} onStart={setStart} onEnd={setEnd} />
      <View style={createS.venueBlock}>
        <TextField label="Tên sân" value={venue} onChangeText={setVenue} placeholder="Ví dụ: Sân Việt Yên 2" />
        <TextField label="Địa chỉ / khu vực" value={address} onChangeText={setAddress} placeholder="Phường, quận, thành phố" />
        <TextField label="Link chia sẻ Google Maps" value={googleMapsUrl} onChangeText={(value) => { setGoogleMapsUrl(value); setCoordinates(null); }} placeholder="Dán link từ nút Chia sẻ của Google Maps" autoCapitalize="none" />
        <SecondaryButton label={resolvingMap ? "ĐANG ĐỌC VỊ TRÍ…" : "XÁC NHẬN VỊ TRÍ TỪ LINK"} disabled={resolvingMap} onPress={() => void resolveMap()} />
        <Text style={createS.mapHint}>{coordinates ? `Đã lưu vị trí sân: ${coordinates.latitude.toFixed(5)}, ${coordinates.longitude.toFixed(5)}. Người chơi sẽ thấy sân theo khoảng cách.` : 'Dán link chia sẻ Google Maps để hệ thống đọc toạ độ sân.'}</Text>
      </View>
      <Stepper label="Sức chứa" value={capacity} set={setCapacity} min={1} />
      <View style={s.switchRow}><Text style={s.small}>Bạn có tham gia?</Text><Switch value={plays} onValueChange={setPlays} trackColor={{ true: colors.brand }} /></View>
      <Stepper label="Người đã có ngoài app" value={reserved} set={setReserved} min={0} />
      <PrimaryButton label="TIẾP TỤC" onPress={() => setStep(2)} />
    </View> : <View style={s.form}>
      <Text style={s.section}>Thông tin thêm</Text>
      <View style={s.chips}><Chip label="Trung bình - Khá" active /><Chip label="Khá - Giỏi" /></View>
      <TextField label="Loại cầu chơi" value={balls} onChangeText={setBalls} hint="Ngăn cách nhiều loại bằng dấu phẩy" />
      <Card><View style={s.switchRow}><View style={{ flex: 1, gap: 3 }}><Text style={s.small}>Host bao cầu</Text><Text style={s.meta}>{hostProvidesBalls ? 'Host chuẩn bị cầu cho cả trận.' : 'Mỗi người tự góp số cầu bên dưới.'}</Text></View><Switch value={hostProvidesBalls} onValueChange={setHostProvidesBalls} trackColor={{ true: colors.brand }} /></View></Card>
      {!hostProvidesBalls && <Stepper label="Mỗi người góp" value={ballsPerPlayer} set={setBallsPerPlayer} min={1} unit="quả cầu" />}
      <Card><Text style={s.small}>Tự động bắt đầu đúng giờ</Text><Text style={s.meta}>Theo cấu hình hiện tại của trận.</Text></Card>
      {created ? <View style={s.form}><StatusBadge label="Đã tạo bản nháp" /><PrimaryButton label="ĐĂNG TRẬN" disabled={busy} onPress={() => void api.publishRoom(created.room_id, created.version).then(() => Alert.alert('Đã đăng trận', 'Trận đã xuất hiện trong danh sách của bạn.')).catch(e => setError(friendlyError(e)))} /><HostManager roomId={created.room_id} /></View> : <PrimaryButton label="TẠO TRẬN" disabled={busy} onPress={() => void create()} />}
      <SecondaryButton label="QUAY LẠI" onPress={() => setStep(1)} />
    </View>}
  </ScrollView>;
}

function SchedulePicker({ start, end, onStart, onEnd }: { start: string; end: string; onStart: (value: string) => void; onEnd: (value: string) => void }) {
  const [editing, setEditing] = useState<'start' | 'end'>('start');
  const [timeTab, setTimeTab] = useState<'hour' | 'minute'>('hour');
  const selected = new Date(editing === 'start' ? start : end);
  const update = (next: Date) => (editing === 'start' ? onStart(next.toISOString()) : onEnd(next.toISOString()));
  return <View style={createS.scheduleBox}>
    <Text style={s.section}>Thời gian thi đấu</Text>
    <View style={createS.scheduleTabs}><Pressable style={[createS.scheduleTab, editing === 'start' && createS.scheduleTabActive]} onPress={() => setEditing('start')}><Text style={[createS.scheduleTabText, editing === 'start' && createS.scheduleTabTextActive]}>Bắt đầu</Text><Text style={[createS.scheduleValue, editing === 'start' && createS.scheduleTabTextActive]}>{formatDateTime(start)}</Text></Pressable><Pressable style={[createS.scheduleTab, editing === 'end' && createS.scheduleTabActive]} onPress={() => setEditing('end')}><Text style={[createS.scheduleTabText, editing === 'end' && createS.scheduleTabTextActive]}>Kết thúc</Text><Text style={[createS.scheduleValue, editing === 'end' && createS.scheduleTabTextActive]}>{formatDateTime(end)}</Text></Pressable></View>
    <CalendarPicker selected={selected} onSelect={update} />
    <Text style={createS.timeLabel}>Chọn thời gian</Text><View style={s.chips}><Chip label="Giờ" active={timeTab === 'hour'} onPress={() => setTimeTab('hour')} /><Chip label="Phút" active={timeTab === 'minute'} onPress={() => setTimeTab('minute')} /></View>
    <View style={s.chips}>{(timeTab === 'hour' ? Array.from({ length: 24 }, (_, hour) => hour) : Array.from({ length: 12 }, (_, index) => index * 5)).map(value => { const active = timeTab === 'hour' ? selected.getHours() === value : selected.getMinutes() === value; return <Chip key={value} label={String(value).padStart(2, '0')} active={active} onPress={() => { const next = new Date(selected); if (timeTab === 'hour') next.setHours(value); else next.setMinutes(value); next.setSeconds(0, 0); update(next); }} />; })}</View>
  </View>;
}

function CalendarPicker({ selected, onSelect }: { selected: Date; onSelect: (date: Date) => void }) {
  const [month, setMonth] = useState(new Date(selected.getFullYear(), selected.getMonth(), 1));
  const firstWeekday = (month.getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: firstWeekday + days }, (_, index) => index < firstWeekday ? null : index - firstWeekday + 1);
  const choose = (day: number) => { const next = new Date(selected); next.setFullYear(month.getFullYear(), month.getMonth(), day); onSelect(next); };
  return <View style={createS.calendar}><View style={createS.calendarHead}><Pressable onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><Text style={createS.monthArrow}>‹</Text></Pressable><Text style={createS.monthTitle}>{month.toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' })}</Text><Pressable onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><Text style={createS.monthArrow}>›</Text></Pressable></View><View style={createS.calendarGrid}>{['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map(day => <Text key={day} style={createS.weekday}>{day}</Text>)}{cells.map((day, index) => day === null ? <View key={`empty-${index}`} style={createS.dayCell} /> : <Pressable key={day} style={[createS.dayCell, selected.getFullYear() === month.getFullYear() && selected.getMonth() === month.getMonth() && selected.getDate() === day && createS.daySelected]} onPress={() => choose(day)}><Text style={[createS.dayText, selected.getFullYear() === month.getFullYear() && selected.getMonth() === month.getMonth() && selected.getDate() === day && createS.dayTextSelected]}>{day}</Text></Pressable>)}</View></View>;
}

function formatDateTime(value: string) { return new Date(value).toLocaleString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function Stepper({ label, value, set, min, unit = 'người' }: { label: string; value: number; set: (n: number) => void; min: number; unit?: string }) { return <View style={s.stepperBox}><Text style={s.small}>{label}</Text><View style={s.stepper}><Pressable onPress={() => set(Math.max(min, value - 1))}><Text style={s.step}>−</Text></Pressable><Text style={s.small}>{value} {unit}</Text><Pressable onPress={() => set(value + 1)}><Text style={s.step}>＋</Text></Pressable></View></View>; }

const managerS = StyleSheet.create({
  playerCard: { gap: 12 }, ratingBox: { backgroundColor: colors.section, borderRadius: radius.input, padding: 11, gap: 7 },
  ratingTitle: { color: colors.text, fontSize: 13, fontWeight: '900' }, ratingHint: { color: colors.muted, fontSize: 11 },
  ratingChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, rankReady: { color: colors.brandStrong, fontSize: 12, fontWeight: '800' }, rankPending: { color: colors.warning, fontSize: 12, fontWeight: '800' },
});

function HostManagerView({ roomId, label = 'Mở quản lý trận' }: { roomId: string; label?: string }) {
  const [data, setData] = useState<HostManagerData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => { try { setData(await api.hostManager(roomId)); } catch (e) { setError(friendlyError(e)); } };
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await load(); } catch (e) { setError(friendlyError(e)); } finally { setBusy(false); } };
  if (!data) return <View style={s.launch}>{error && <ErrorBanner message={error} />}<SecondaryButton label={label} onPress={() => void load()} /></View>;
  return <View style={s.manager}>
    <View style={s.managerHead}><Text style={s.managerKicker}>Quản lý trận (Host)</Text><Text style={s.managerTitle}>{data.venue.name}</Text><Text style={s.managerMeta}>{date(data.schedule.start_at)} · {status(data.status)}</Text></View>
    <View style={s.stats}><Stat value={String(data.capacity.total)} label="Sức chứa" /><Stat value={String(data.manager.accepted_participants.length)} label="Đã duyệt" /><Stat value={String(data.manager.available_public_slots)} label="Còn trống" /></View>
    <SectionHeader title="Yêu cầu tham gia" />
    {data.manager.pending_applications.length ? data.manager.pending_applications.map(app => <Card key={app.application_id}><View style={s.host}><Avatar name={app.members[0]?.display_name ?? 'K'} /><View style={{ flex: 1 }}><Text style={s.roomTitle}>{app.members.map(m => m.display_name ?? 'Khách').join(', ')}</Text><Text style={s.meta}>Yêu cầu {app.requested_slot_count} chỗ</Text></View></View><View style={s.actions}><SecondaryButton label="TỪ CHỐI" disabled={busy} onPress={() => void act(() => api.rejectApplication(app.application_id))} /><PrimaryButton label="CHẤP NHẬN" disabled={busy} onPress={() => void act(() => api.acceptApplication(app.application_id))} style={{ flex: 1 }} /></View></Card>) : <EmptyState title="Chưa có yêu cầu" description="Yêu cầu tham gia mới sẽ hiện ở đây." />}
    <SectionHeader title="Người chơi & đánh giá" />
    {data.manager.accepted_participants.map(person => <Card key={person.participant_id} style={managerS.playerCard}>
      <View style={s.host}><Avatar name={person.display_name ?? 'K'} /><View style={{ flex: 1, gap: 3 }}><Text style={s.roomTitle}>{person.display_name ?? 'Khách'}</Text><Text style={s.meta}>{status(person.attendance_status)}</Text><SkillSummary person={person} /></View>{data.status === 'IN_PROGRESS' && <View style={{ gap: 7 }}><Pressable onPress={() => void act(() => api.markPresent(person.participant_id))}><Text style={s.present}>Có mặt</Text></Pressable><Pressable onPress={() => void act(() => api.markNoShow(person.participant_id))}><Text style={s.absent}>Vắng</Text></Pressable></View>}</View>
      {person.rating?.eligible && !person.rating.rating_submitted && <RatingPicker disabled={busy} onRate={(value) => void act(() => api.submitSkillRating(person.participant_id, value))} />}
      {person.rating?.rating_submitted && <StatusBadge label="Đã đánh giá trận này" />}
      {person.attendance_status === 'PRESENT' && person.rating && !person.rating.eligible && !person.rating.rating_submitted && <Text style={managerS.ratingHint}>Chưa đủ điều kiện đánh giá ở trận này.</Text>}
    </Card>)}
    {data.manager.allowed_actions.includes('START_ROOM') && <PrimaryButton label="BẮT ĐẦU TRẬN" disabled={busy} onPress={() => void act(() => api.startRoom(roomId))} />}
    {data.manager.allowed_actions.includes('COMPLETE_ROOM') && <PrimaryButton label="HOÀN TẤT ĐIỂM DANH" disabled={busy} onPress={() => void act(() => api.completeRoom(roomId))} />}
  </View>;
}
function SkillSummary({ person }: { person: HostManagerData['manager']['accepted_participants'][number] }) { if (!person.skill) return <Text style={managerS.rankPending}>Khách ngoài app · không có xếp hạng</Text>; if (person.skill.rank_tier === null) return <Text style={managerS.rankPending}>Đang xếp hạng · {person.skill.valid_rating_count}/10 đánh giá</Text>; return <Text style={managerS.rankReady}>Hạng {person.skill.rank_tier} · {person.skill.score?.toFixed(1) ?? '—'} điểm · Tin cậy {person.skill.confidence_level === 'HIGH' ? 'cao' : person.skill.confidence_level === 'MEDIUM' ? 'vừa' : 'thấp'}</Text>; }
function RatingPicker({ disabled, onRate }: { disabled: boolean; onRate: (value: number) => void }) { return <View style={managerS.ratingBox}><Text style={managerS.ratingTitle}>Đánh giá trình độ</Text><Text style={managerS.ratingHint}>Chọn nhanh theo mức 1–10</Text><View style={managerS.ratingChoices}>{[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(value => <Chip key={value} label={String(value)} disabled={disabled} onPress={() => onRate(value)} />)}</View></View>; }
const HostManager = HostManagerView;
function Stat({ value, label }: { value: string; label: string }) { return <View style={s.stat}><Text style={s.statValue}>{value}</Text><Text style={s.meta}>{label}</Text></View>; }

function Profile({ me, setMe, signOut }: { me: Me; setMe: (next: Me) => void; signOut: () => void }) { const [edit, setEdit] = useState(false); const [name, setName] = useState(me.display_name); const [phone, setPhone] = useState(me.phone); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const save = async () => { setBusy(true); try { setMe(await api.updateMe({ display_name: name, phone })); setEdit(false); } catch (e) { setError(friendlyError(e)); } finally { setBusy(false); } }; return <ScrollView contentContainerStyle={s.profile}><View style={s.profileHero}><Avatar name={me.display_name} size={72} /><Text style={s.profileName}>{me.display_name}</Text><StatusBadge label={me.sports[0]?.skill_state === 'ESTABLISHED' ? 'Đã xác lập trình độ' : 'Đang xác lập trình độ'} /><Text style={s.profileMeta}>{me.phone} · {me.email}</Text></View><View style={[s.content, { paddingTop: 22 }]}>{edit ? <View style={s.form}><Text style={s.screen}>Thông tin cá nhân</Text><TextField label="Tên hiển thị" value={name} onChangeText={setName} /><TextField label="Số điện thoại" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />{error && <ErrorBanner message={error} />}<PrimaryButton label="LƯU THAY ĐỔI" disabled={busy} onPress={() => void save()} /><SecondaryButton label="HỦY" onPress={() => setEdit(false)} /></View> : <View style={s.form}><Menu label="Thông tin cá nhân" onPress={() => setEdit(true)} /><Menu label="Lịch sử trận đấu" /><Menu label="Cài đặt" /><View style={s.coming}><Text style={s.meta}>Thống kê và bạn bè sẽ có trong bản sau.</Text></View><Pressable onPress={() => void signOut()}><Text style={s.logout}>Đăng xuất</Text></Pressable></View>}</View></ScrollView>; }
function Menu({ label, onPress }: { label: string; onPress?: () => void }) { return <Pressable onPress={onPress} style={s.menu}><Text style={s.small}>{label}</Text><Text style={s.menuArrow}>›</Text></Pressable>; }
function Nav({ tab, setTab }: { tab: Tab; setTab: (tab: Tab) => void }) {
  const tabs: { id: Tab; label: string; icon: 'home' | 'calendar' | 'create' | 'profile' }[] = [
    { id: 'discover', icon: 'home', label: 'Khám phá' }, { id: 'matches', icon: 'calendar', label: 'Trận của tôi' },
    { id: 'create', icon: 'create', label: 'Tạo trận' }, { id: 'profile', icon: 'profile', label: 'Tài khoản' },
  ];
  return <View style={s.nav}>{tabs.slice(0, 3).map(item => <Pressable key={item.id} onPress={() => setTab(item.id)} style={s.navItem}><AppIcon name={item.icon} size={21} color={tab === item.id ? colors.brand : '#89938E'} /><Text style={[s.navLabel, tab === item.id && s.active]}>{item.label}</Text></Pressable>)}<View accessibilityLabel="Thông báo chưa được hỗ trợ trong private alpha" style={s.navItem}><AppIcon name="bell" size={21} color="#89938E" /><Text style={s.navLabel}>Thông báo</Text></View>{tabs.slice(3).map(item => <Pressable key={item.id} onPress={() => setTab(item.id)} style={s.navItem}><AppIcon name={item.icon} size={21} color={tab === item.id ? colors.brand : '#89938E'} /><Text style={[s.navLabel, tab === item.id && s.active]}>{item.label}</Text></Pressable>)}</View>;
}

const s = StyleSheet.create({ page: { flex: 1, backgroundColor: colors.background }, shell: { flex: 1, width: '100%', maxWidth: 520, alignSelf: 'center' }, content: { padding: space.lg, gap: space.lg, paddingBottom: 32 }, entry: { flex: 1, backgroundColor: colors.brandStrong, padding: 20, justifyContent: 'space-between' }, entryHero: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }, logo: { color: '#fff', fontSize: 47, fontWeight: '900', letterSpacing: -2 }, tagline: { color: '#D9F9E6', textAlign: 'center', fontSize: 16, lineHeight: 24 }, court: { width: 150, height: 115, borderRadius: radius.hero, borderWidth: 2, borderColor: '#66BE89', alignItems: 'center', justifyContent: 'center' }, courtIcon: { fontSize: 72, color: '#D9F9E6' }, entryActions: { gap: 12 }, alpha: { color: '#D9F9E6', textAlign: 'center', marginTop: 6, fontSize: 12 }, auth: { flex: 1, backgroundColor: colors.background }, authBody: { width: '100%', maxWidth: 440, alignSelf: 'center', flexGrow: 1, justifyContent: 'center', padding: 24, gap: 18 }, back: { color: colors.text, fontSize: 34, lineHeight: 34 }, authTitle: { color: colors.text, fontSize: 26, fontWeight: '900' }, authSub: { color: colors.muted, fontSize: 14, marginTop: -10 }, form: { gap: 15 }, link: { color: colors.brand, fontSize: 12, fontWeight: '800' }, location: { flexDirection: 'row', justifyContent: 'space-between' }, locationText: { color: colors.brandStrong, fontSize: 12, fontWeight: '800' }, greet: { color: colors.text, fontSize: 24, fontWeight: '900', marginTop: 4 }, sub: { color: colors.muted, fontSize: 14, marginTop: -14 }, sportList: { gap: 10 }, sport: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: 14, width: 90, height: 82, alignItems: 'center', justifyContent: 'center', gap: 7 }, sportSelected: { backgroundColor: colors.brand, borderColor: colors.brand }, sportMark: { color: colors.brand, fontSize: 23 }, sportText: { color: colors.text, fontSize: 11, fontWeight: '800', textAlign: 'center' }, white: { color: '#fff' }, roomCard: { backgroundColor: '#fff', borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, padding: 10, flexDirection: 'row', gap: 12, ...shadow }, thumb: { width: 70, minHeight: 76, backgroundColor: '#D8F0E2', borderRadius: 12, justifyContent: 'center', alignItems: 'center' }, thumbText: { color: colors.brand, fontSize: 36 }, cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 5 }, roomTitle: { color: colors.text, fontSize: 15, fontWeight: '900' }, meta: { color: colors.muted, fontSize: 12 }, small: { color: colors.text, fontSize: 14, fontWeight: '700' }, hero: { height: 176, backgroundColor: colors.brandStrong, borderRadius: radius.hero, alignItems: 'center', justifyContent: 'center', gap: 6 }, heroIcon: { fontSize: 78, color: '#D9F9E6' }, detailTitle: { color: colors.text, fontWeight: '900', fontSize: 25, marginTop: -9 }, section: { color: colors.text, fontSize: 15, fontWeight: '800' }, host: { flexDirection: 'row', alignItems: 'center', gap: 10 }, info: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 5 }, top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, screen: { color: colors.text, fontSize: 24, fontWeight: '900' }, filter: { gap: 10 }, chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 }, group: { gap: 4 }, stepperBox: { gap: 9 }, stepper: { height: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.input, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' }, step: { color: colors.brand, fontWeight: '900', fontSize: 20, padding: 8 }, launch: { marginTop: 4 }, manager: { gap: 14, marginTop: 6 }, managerHead: { backgroundColor: colors.brandStrong, borderRadius: radius.card, padding: 18, gap: 4 }, managerKicker: { color: '#D9F9E6', fontSize: 12, fontWeight: '800' }, managerTitle: { color: '#fff', fontSize: 21, fontWeight: '900' }, managerMeta: { color: '#D9F9E6', fontSize: 12 }, stats: { flexDirection: 'row', padding: 10, backgroundColor: '#fff', borderRadius: radius.card, borderWidth: 1, borderColor: colors.border }, stat: { flex: 1, alignItems: 'center', gap: 3 }, statValue: { color: colors.brand, fontSize: 20, fontWeight: '900' }, actions: { flexDirection: 'row', gap: 8 }, present: { color: colors.success, fontWeight: '800', fontSize: 12 }, absent: { color: colors.error, fontWeight: '800', fontSize: 12 }, profile: { paddingBottom: 30 }, profileHero: { alignItems: 'center', gap: 9, backgroundColor: colors.brandStrong, padding: 25, borderBottomLeftRadius: radius.hero, borderBottomRightRadius: radius.hero }, profileName: { color: '#fff', fontSize: 22, fontWeight: '900' }, profileMeta: { color: '#D9F9E6', fontSize: 12 }, menu: { minHeight: 56, borderBottomWidth: 1, borderColor: colors.border, alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, menuArrow: { color: colors.muted, fontSize: 27 }, coming: { backgroundColor: '#F1F3F2', padding: 13, borderRadius: radius.input }, logout: { color: colors.error, fontSize: 14, fontWeight: '800', paddingVertical: 14 }, nav: { width: '100%', maxWidth: 520, alignSelf: 'center', flexDirection: 'row', backgroundColor: '#fff', borderTopWidth: 1, borderColor: colors.border, paddingTop: 8, paddingBottom: 10 }, navItem: { flex: 1, alignItems: 'center', gap: 3 }, navIcon: { color: colors.muted, fontSize: 19, fontWeight: '900' }, navLabel: { color: colors.muted, fontSize: 10, fontWeight: '700' }, active: { color: colors.brand } });
